import { openServer, parseServerConfig } from '@runejs/core/net';
import {
    FileStore
} from '../../filestore';
import { UpdateServerConnection } from './update-server-connection';
import { logger } from '@runejs/core';
import { ByteBuffer } from '@runejs/core/buffer';
import { IndexName } from '../../filestore/dist/file-store/archive';


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
    public indexFiles: ByteBuffer[];

    private zipArchives: any[];

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
        try {
            const start = Date.now();

            this.fileStore = new FileStore('../filestore/stores');
            this.crcTable = Buffer.from(await this.fileStore.generateCrcTable());
            const indexCount = this.fileStore.indexedArchives.size;
            this.indexFiles = new Array(indexCount);
            // this.zipArchives = new Array(indexCount);

            for(let index = 0; index < indexCount; index++) {
                const indexedArchive = this.fileStore.indexedArchives.get(index);
                if(!indexedArchive) {
                    continue;
                }

                this.indexFiles[index] = await indexedArchive.generateIndexFile();
                // this.zipArchives[index] = await indexedArchive.loadZip();
                logger.info(`Index file ${index} length: ${this.indexFiles[index].length}`);
            }

            for(let index = 0; index < indexCount; index++) {
                logger.info(`Loading files for archive ${index}...`);
                await this.fileStore.indexedArchives.get(index).unpack(true, false);
                logger.info(`Archive ${index} loaded.`);
            }

            const end = Date.now();
            const duration = end - start;

            logger.info(`FileStore loaded in ${duration / 1000} seconds.`);
        } catch(e) {
            logger.error(e);
        }
    }

    public async generateFile(index: number, file: number): Promise<Buffer> {
        logger.info(`File requested: ${index} ${file}`);

        if(index === 255 && file === 255) {
            const crcTableCopy = new ByteBuffer(this.crcTable.length);
            this.crcTable.copy(crcTableCopy, 0, 0);

            const crcFileBuffer = new ByteBuffer(86);
            crcFileBuffer.put(255);
            crcFileBuffer.put(255, 'short');
            crcFileBuffer.putBytes(crcTableCopy, 0, 83);
            return Buffer.from(crcFileBuffer);
        }

        let cacheFile: ByteBuffer;
        let indexName: IndexName = 'main';

        try {
             if(index === 255) {
                const indexFile = this.indexFiles[file];
                if(!indexFile) {
                    logger.error(`Index file ${file} not found.`);
                } else {
                    cacheFile = new ByteBuffer(indexFile.length);
                    indexFile.copy(cacheFile, 0, 0);
                }
            } else {
                 const indexedArchive = this.fileStore.indexedArchives.get(index);
                 indexName = indexedArchive.manifest.name;
                 const indexedFile = indexedArchive.files[file];
                 if(indexedFile) {
                     if(!indexedFile.fileDataCompressed) {
                         await indexedFile.compress();
                     }
                     if(indexedFile.fileData) {
                         cacheFile = new ByteBuffer(indexedFile.fileData.length);
                         indexedFile.fileData.copy(cacheFile, 0, 0);
                     }
                 }
            }
        } catch(error) {
            logger.error(`Error requesting file ${file} in index ${index}.`);
            logger.error(error);
        }

        if(!cacheFile || cacheFile.length === 0) {
            logger.error(`File ${file} in index ${indexName} was not found.`);
            /*const missingFile = new ByteBuffer(8);
            missingFile.put(index);
            missingFile.put(file, 'short');
            missingFile.put(0);
            missingFile.put(0, 'int');
            return Buffer.from(missingFile);*/
            return null;
        }

        if(cacheFile.length < 5) {
            logger.error(`File ${file} in index ${indexName} is corrupt.`);
            return null;
        }

        const compression: number = cacheFile.get();
        const length: number = cacheFile.get('int') + (compression === 0 ? 5 : 9);
        const buffer = new ByteBuffer((length - 2) + ((length - 2) / 511) + 8);

        buffer.put(index);
        buffer.put(file, 'short');

        let s = 3;
        for(let i = 0; i < length; i++) {
            if(s === 512) {
                buffer.put(255);
                s = 1;
            }

            buffer.put(cacheFile.at(i));
            s++;
        }

        // logger.info(`Resulting length ${buffer.length} writer index ${buffer.writerIndex} s ${s}`);

        return Buffer.from(buffer.flipWriter());
    }

}
