import { SocketConnectionHandler } from '@runejs/core/net';
import { Socket } from 'net';
import { ByteBuffer } from '@runejs/core/buffer';
import { logger } from '@runejs/core';
import UpdateServer from './update-server';


export enum UpdateServerConnectionStage {
    HANDSHAKE = 'handshake',
    ACTIVE = 'active'
}


export class UpdateServerConnection extends SocketConnectionHandler {

    private connectionStage: UpdateServerConnectionStage = UpdateServerConnectionStage.HANDSHAKE;
    private files: { file: number, index: number }[] = [];

    public constructor(private readonly updateServer: UpdateServer,
                       private readonly gameServerSocket: Socket) {
        super();
    }

    public dataReceived(buffer: ByteBuffer): void {
        if(!buffer) {
            logger.info('No data supplied in message to update server.');
            return;
        }

        switch(this.connectionStage) {
            case UpdateServerConnectionStage.HANDSHAKE:
                const gameVersion = buffer.get('INT');
                const outputBuffer = new ByteBuffer(1);

                if(gameVersion === 435) {
                    outputBuffer.put(0); // good to go!
                    this.connectionStage = UpdateServerConnectionStage.ACTIVE;
                    this.gameServerSocket.write(outputBuffer);
                } else {
                    outputBuffer.put(6); // out of date
                    this.gameServerSocket.write(outputBuffer);
                }
                break;
            case UpdateServerConnectionStage.ACTIVE:
                while(buffer.readable >= 4) {
                    const type = buffer.get('byte', 'u');
                    const index = buffer.get('byte', 'u');
                    const file = buffer.get('short', 'u');

                    switch(type) {
                        case 0: // queue
                            this.files.push({ index, file });
                            break;
                        case 1: // immediate
                            this.updateServer.generateFile(index, file).then(fileData => {
                                if(fileData) {
                                    this.gameServerSocket.write(fileData);
                                } else {
                                    logger.error(`File ${index} ${file} is missing.`);
                                    this.gameServerSocket.write(this.generateEmptyFile(index, file));
                                }
                            });
                            break;
                        case 2:
                        case 3: // clear queue
                            this.files = [];
                            break;
                        case 4: // error
                            break;
                    }

                    while(this.files.length > 0) {
                        const info = this.files.shift();
                        this.updateServer.generateFile(info.index, info.file).then(fileData => {
                            if(fileData) {
                                this.gameServerSocket.write(fileData);
                            } else {
                                logger.error(`File ${info.index} ${info.file} is missing.`);
                                this.gameServerSocket.write(this.generateEmptyFile(info.index, info.file));
                            }
                        });
                    }
                }
                break;
            default:
                break;
        }
    }

    public connectionDestroyed(): void {
    }

    public generateEmptyFile(index: number, file: number): Buffer {
        const buffer = new ByteBuffer(9);
        buffer.put(index);
        buffer.put(file, 'short');
        buffer.put(0); // compression
        buffer.put(1, 'int'); // file length
        buffer.put(0); // single byte of data
        return Buffer.from(buffer);
    }

}
