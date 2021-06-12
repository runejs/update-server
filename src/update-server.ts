import { logger } from '@runejs/core';
import { ByteBuffer } from '@runejs/core/buffer';
import { openServer, SocketConnectionHandler, parseServerConfig } from '@runejs/core/net';
import { Socket } from 'net';
import { FileStore, compressVersionedFile } from '../../filestore';


interface ServerConfig {
    updateServerHost: string;
    updateServerPort: number;
    cacheDir: string;
    configDir?: string;
}

enum ConnectionStage {
    HANDSHAKE = 'handshake',
    ACTIVE = 'active'
}

class UpdateServerConnection extends SocketConnectionHandler {

    private connectionStage: ConnectionStage = ConnectionStage.HANDSHAKE;
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
            case ConnectionStage.HANDSHAKE:
                const gameVersion = buffer.get('INT');
                const outputBuffer = new ByteBuffer(1);

                if(gameVersion === 435) {
                    outputBuffer.put(0); // good to go!
                    this.connectionStage = ConnectionStage.ACTIVE;
                    this.gameServerSocket.write(outputBuffer);
                } else {
                    outputBuffer.put(6); // out of date
                    this.gameServerSocket.write(outputBuffer);
                }
                break;
            case ConnectionStage.ACTIVE:
                while(buffer.readable >= 4) {
                    const type = buffer.get('byte', 'u');
                    const index = buffer.get('byte', 'u');
                    const file = buffer.get('short', 'u');

                    switch(type) {
                        case 0: // queue
                            this.files.push({ index, file });
                            break;
                        case 1: // immediate
                            this.gameServerSocket.write(await this.generateFile(index, file));
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
                        this.gameServerSocket.write(await this.generateFile(info.index, info.file));
                    }
                }
                break;
            default:
                break;
        }

        return Promise.resolve(undefined);
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
                const buffer = await this.updateServer.fileStore.indexedArchives.get(file).compressIndexData();
                cacheFile = compressVersionedFile({
                    buffer,
                    compression: 0,
                    version: 0
                });
            } else {
                cacheFile = await this.updateServer.fileStore.getFile(index, file, true);
            }
        } catch(error) {
            logger.error(`Unable to load filestore file for update server request`, index, file);
            logger.error(error);
        }

        if(!cacheFile || cacheFile.length === 0) {
            throw new Error(`Cache file not found; file(${file}) with index(${index}).`);
        }

        const buffer = new ByteBuffer((cacheFile.length - 2) + ((cacheFile.length - 2) / 511) + 8);

        buffer.put(index);
        buffer.put(file, 'short');

        logger.info(`Compressed file length ${cacheFile.length}`);

        let c = 3;
        for(let i = 0; i < cacheFile.length; i++) {
            if(c === 512) {
                buffer.put(255);
                c = 1;
            }

            buffer.put(cacheFile.at(i));
            c++;
        }

        return Buffer.from(buffer.flipWriter());
    }

}

class UpdateServer {

    public readonly serverConfig: ServerConfig;
    public fileStore: FileStore;
    public crcTable: ByteBuffer;
    public indexChannels: ByteBuffer[];

    public constructor(host?: string, port?: number, cacheDir?: string) {
        if(!host) {
            this.serverConfig = parseServerConfig<ServerConfig>();
        } else {
            this.serverConfig = {
                updateServerHost: host,
                updateServerPort: port,
                cacheDir
            };
        }
    }

    public async loadFileStore(): Promise<void> {
        this.fileStore = new FileStore('../filestore/stores');
        this.crcTable = await this.fileStore.generateCrcTable();
    }

}

export const launchUpdateServer = async (host?: string, port?: number, cacheDir?: string): Promise<void> => {
    const updateServer = new UpdateServer(host, port, cacheDir);
    await updateServer.loadFileStore();
    openServer<UpdateServerConnection>('Update Server', updateServer.serverConfig.updateServerHost, updateServer.serverConfig.updateServerPort,
        socket => new UpdateServerConnection(updateServer, socket));
};
