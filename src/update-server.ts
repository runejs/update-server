import { openServer, parseServerConfig } from '@runejs/core/net';
import { compressVersionedFile, FileStore, getCompressionKey } from '../../filestore';
import { UpdateServerConnection } from './update-server-connection';
import { logger } from '@runejs/core';


export const defaultStoreDirectory = '../filestore/stores';


export interface UpdateServerConfig {
    updateServerHost: string;
    updateServerPort: number;
    storeDir: string;
}


export default class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: FileStore;
    public crcTable: Buffer;
    public indexFiles: Buffer[];

    public constructor(host?: string, port?: number) {
        if(!host) {
            this.serverConfig = parseServerConfig<UpdateServerConfig>();
        } else {
            this.serverConfig = {
                updateServerHost: host,
                updateServerPort: port,
                storeDir: defaultStoreDirectory
            };
        }

        if(!this.serverConfig.updateServerHost || !this.serverConfig.updateServerPort) {
            throw new Error(`Please provide a valid host and port for the Update Server.`);
        }

        if(!this.serverConfig.storeDir) {
            throw new Error(`Update Server asset store directory was not provided. Please add storeDir to the Update Server configuration file.`);
        }
    }

    public static async launch(host?: string, port?: number): Promise<UpdateServer> {
        const updateServer = new UpdateServer(host, port);

        await updateServer.loadFileStore();

        openServer<UpdateServerConnection>('Update Server',
            updateServer.serverConfig.updateServerHost, updateServer.serverConfig.updateServerPort,
            socket => new UpdateServerConnection(updateServer, socket));

        return updateServer;
    }

    public async loadFileStore(): Promise<void> {
        this.fileStore = new FileStore('../filestore/stores');
        this.crcTable = Buffer.from(await this.fileStore.generateCrcTable());
        const indexCount = this.fileStore.indexedArchives.size;
        this.indexFiles = new Array(indexCount);

        for(let index = 0; index < indexCount; index++) {
            const indexedArchive = this.fileStore.indexedArchives.get(index);
            if(!indexedArchive) {
                continue;
            }

            this.indexFiles[index] = Buffer.from(await indexedArchive.compressIndexData());
            logger.info(`Index file ${index} length: ${this.indexFiles[index].length}`);
        }
    }

}
