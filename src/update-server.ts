import { parseServerConfig, SocketServer } from '@runejs/core/net';
import { FileStore } from '../../filestore';
import { UpdateServerConnection } from './net/update-server-connection';
import { logger } from '@runejs/core';
import { ByteBuffer } from '@runejs/core/buffer';
import { IndexName } from '../../filestore/dist/file-store/archive';
import { FileRequest } from './net/file-request';
import { defaultConfig, UpdateServerConfig } from './config/update-server-config';


export default class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: FileStore;
    public crcTable: Buffer;
    public indexFiles: ByteBuffer[];

    public constructor(host?: string, port?: number) {
        if(!host) {
            this.serverConfig = parseServerConfig<UpdateServerConfig>();
        } else {
            this.serverConfig = {
                updateServerHost: host,
                updateServerPort: port,
                storeDir: defaultConfig.storeDir,
                clientVersion: defaultConfig.clientVersion
            };
        }

        if(!this.serverConfig.updateServerHost || !this.serverConfig.updateServerPort) {
            throw new Error(`Update Server host or port not provided. ` +
                `Please add updateServerHost and updateServerPort to your configuration file.`);
        }

        if(!this.serverConfig.storeDir) {
            throw new Error(`Update Server asset store directory was not provided. ` +
                `Please add storeDir to your configuration file.`);
        }

        if(!this.serverConfig.clientVersion) {
            throw new Error(`Update Server supported client version was not provided. ` +
                `Please add clientVersion to your configuration file.`);
        }
    }

    public static async launch(host?: string, port?: number): Promise<UpdateServer> {
        const updateServer = new UpdateServer(host, port);

        await updateServer.loadFileStore();

        SocketServer.launch<UpdateServerConnection>('Update Server',
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

            for(let index = 0; index < indexCount; index++) {
                const indexedArchive = this.fileStore.indexedArchives.get(index);
                if(!indexedArchive) {
                    continue;
                }

                this.indexFiles[index] = await indexedArchive.generateIndexFile();
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

    public async handleFileRequest(fileRequest: FileRequest): Promise<Buffer> {
        const { indexId, fileId } = fileRequest;

        if(indexId === 255) {
            return fileId === 255 ? this.generateCrcTableFile() : this.generateArchiveIndexFile(fileId);
        }

        const indexedArchive = indexId === 255 ? null : this.fileStore.indexedArchives.get(indexId);
        const indexName: IndexName = indexedArchive?.manifest?.name ?? 'main';

        logger.info(`Asset file requested: ${indexName} ${fileId}`);

        const indexedFile = indexedArchive.files[fileId];
        if(indexedFile) {
            if(!indexedFile.fileDataCompressed) {
                await indexedFile.compress();
            }
            if(indexedFile.fileData) {
                const cacheFile = new ByteBuffer(indexedFile.fileData.length);
                indexedFile.fileData.copy(cacheFile, 0, 0);
                return this.createFileResponse(fileRequest, cacheFile);
            }
        }

        logger.error(`File ${fileId} in index ${indexName} is empty.`);
        return null;
    }

    protected createFileResponse(fileRequest: FileRequest, fileDataBuffer: ByteBuffer): Buffer | null {
        const { indexId, fileId } = fileRequest;

        const indexedArchive = indexId === 255 ? null : this.fileStore.indexedArchives.get(indexId);
        const indexName: IndexName = indexedArchive?.manifest?.name ?? 'main';

        if(!fileDataBuffer || fileDataBuffer.length === 0) {
            logger.error(`File ${fileId} in index ${indexName} was not found.`);
            return null;
        }

        if(fileDataBuffer.length < 5) {
            logger.error(`File ${fileId} in index ${indexName} is corrupt.`);
            return null;
        }

        const compression: number = fileDataBuffer.get('byte');
        const length: number = fileDataBuffer.get('int') + (compression === 0 ? 5 : 9);
        const buffer = new ByteBuffer((length - 2) + ((length - 2) / 511) + 8);

        buffer.put(indexId);
        buffer.put(fileId, 'short');

        let s = 3;
        for(let i = 0; i < length; i++) {
            if(s === 512) {
                buffer.put(255);
                s = 1;
            }

            buffer.put(fileDataBuffer.at(i));
            s++;
        }

        return Buffer.from(buffer.flipWriter());
    }

    protected generateArchiveIndexFile(archiveId: number): Buffer {
        const indexFile = this.indexFiles[archiveId];
        const cacheFile = new ByteBuffer(indexFile.length);
        indexFile.copy(cacheFile, 0, 0);
        return this.createFileResponse({ indexId: 255, fileId: archiveId }, indexFile);
    }

    protected generateCrcTableFile(): Buffer {
        const crcTableCopy = new ByteBuffer(this.crcTable.length);
        this.crcTable.copy(crcTableCopy, 0, 0);
        const crcFileBuffer = new ByteBuffer(86);
        crcFileBuffer.put(255);
        crcFileBuffer.put(255, 'short');
        crcFileBuffer.putBytes(crcTableCopy, 0, 83);
        return Buffer.from(crcFileBuffer);
    }

    protected generateEmptyFile(index: number, file: number): Buffer {
        const buffer = new ByteBuffer(9);
        buffer.put(index);
        buffer.put(file, 'short');
        buffer.put(0); // compression
        buffer.put(1, 'int'); // file length
        buffer.put(0); // single byte of data
        return Buffer.from(buffer);
    }

}
