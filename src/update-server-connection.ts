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

    public async dataReceived(buffer: ByteBuffer): Promise<void> {
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
                            const fileData = await this.generateFile(index, file);
                            this.gameServerSocket.write(fileData);
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
                        const fileData = await this.generateFile(info.index, info.file);
                        this.gameServerSocket.write(fileData);
                    }
                }
                break;
            default:
                break;
        }
    }

    public connectionDestroyed(): void {
    }

    private async generateFile(index: number, file: number): Promise<Buffer> {
        let cacheFile: ByteBuffer;

        logger.info(`File request ${index} ${file}`);

        try {
            if(index === 255 && file === 255) {
                cacheFile = new ByteBuffer(this.updateServer.crcTable.length);
                this.updateServer.crcTable.copy(cacheFile, 0, 0);
            } else if(index === 255) {
                const indexFile = this.updateServer.indexFiles[file];
                if(!indexFile) {
                    logger.error(`Index file ${file} not found.`);
                } else {
                    cacheFile = new ByteBuffer(indexFile.length);
                    indexFile.copy(cacheFile, 0, 0);
                }
            } else {
                cacheFile = await this.updateServer.fileStore.getFile(index, file, true);
            }
        } catch(error) {
            logger.error(`Error requesting file(${file}) in index(${index}).`);
            logger.error(error);
        }

        if(!cacheFile || cacheFile.length === 0) {
            throw new Error(`File(${file}) in index(${index}) was not found.`);
        }

        const buffer = new ByteBuffer((cacheFile.length - 2) + ((cacheFile.length - 2) / 511) + 8);

        buffer.put(index);
        buffer.put(file, 'short');

        // Read the file length and set the length for the update server buffer
        let length: number = ((cacheFile.at(1, 'UNSIGNED') << 24) + (cacheFile.at(2, 'UNSIGNED') << 16) +
            (cacheFile.at(3, 'UNSIGNED') << 8) + cacheFile.at(4, 'UNSIGNED')) + 9;
        if(cacheFile.at(0) === 0) {
            length -= 4;
        }

        logger.info(`Requested file length: ${length}`);

        let s = 3;
        for(let i = 0; i < length; i++) {
            if(s === 512) {
                buffer.put(255);
                s = 1;
            }

            const b = cacheFile.at(i);
            buffer.put(b);
            s++;
        }

        buffer.putBytes(cacheFile, 0, length);

        if(file !== 255) {
            console.log(buffer);
        }

        return Buffer.from(buffer);
    }

}
