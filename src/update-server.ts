import { FileRequest } from './net/file-request';
import { UpdateServerConfig } from './config/update-server-config';
import { parseServerConfig, SocketServer } from '@runejs/core/net';
import { UpdateServerConnection } from './net/update-server-connection';
import { FileStore, getIndexName, IndexName } from '../../filestore';
import { ByteBuffer } from '@runejs/core/buffer';
import { logger } from '@runejs/core';


export default class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: FileStore;
    public crcTable: Buffer;
    public indexFiles: ByteBuffer[];

    private incomingRequests: string[] = [];
    private batchLimit: number = 30;

    public constructor(configDir?: string) {
        this.serverConfig = parseServerConfig<UpdateServerConfig>({ configDir });

        if(!this.serverConfig.clientVersion) {
            throw new Error(`Update Server supported client version was not provided. ` +
                `Please add clientVersion to your configuration file.`);
        }
    }

    public static async launch(configDir?: string): Promise<UpdateServer> {
        const updateServer = new UpdateServer(configDir);

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
        const indexName: IndexName = getIndexName(indexId);

        // this.incomingRequests.push(`${indexName} ${fileId}`);
        //
        // if(this.incomingRequests.length >= this.batchLimit) {
        //     logger.info(`${this.batchLimit} files requested: ${this.incomingRequests.join(', ')}`);
        //     this.incomingRequests = [];
        // }

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

        const indexName: IndexName = getIndexName(indexId);

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
