import { FileRequest } from './net/file-request';
import { UpdateServerConfig } from './config/update-server-config';
import { parseServerConfig, SocketServer } from '@runejs/core/net';
import { UpdateServerConnection } from './net/update-server-connection';
import { ByteBuffer } from '@runejs/core/buffer';
import { logger } from '@runejs/core';
import { FlatFileStore } from '../../filestore';
import { File, Group } from '@runejs/filestore';


export default class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: FlatFileStore;
    public mainIndexFile: Buffer;

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

            this.fileStore = new FlatFileStore({
                storePath: this.serverConfig.storeDir,
                configPath: this.serverConfig.configDir,
                gameVersion: this.serverConfig.clientVersion
            });
            
            this.fileStore.readStore(true);

            this.mainIndexFile = this.generateMainIndexFile().toNodeBuffer();

            const end = Date.now();
            const duration = end - start;

            logger.info(`File Store loaded in ${duration / 1000} seconds.`);
        } catch(e) {
            logger.error(e);
        }
    }

    public generateMainIndexFile(): ByteBuffer {
        logger.info(`Generating main index file...`);
        const indexCount = this.fileStore.archives.size - 1; // exclude the main archive 
        const crcTableFileSize = 78;
        const buffer = new ByteBuffer(4096);

        buffer.put(0, 'byte'); // compression level (none)
        buffer.put(crcTableFileSize, 'int'); // file size

        for(let archiveIndex = 0; archiveIndex < indexCount; archiveIndex++) {
            const archive = this.fileStore.getArchive(String(archiveIndex));
            buffer.put(archive.crc32, 'int');
        }

        return buffer;
    }

    public handleFileRequest(fileRequest: FileRequest): Buffer {
        const { archiveIndex, fileIndex } = fileRequest;

        if(archiveIndex === 255) {
            return fileIndex === 255 ? this.generateCrcTableFile() : this.generateArchiveIndexFile(fileIndex);
        }

        const archive = archiveIndex === 255 ? null : this.fileStore.getArchive(String(archiveIndex));
        const archiveName = archive.name;

        // this.incomingRequests.push(`${indexName} ${fileId}`);
        //
        // if(this.incomingRequests.length >= this.batchLimit) {
        //     logger.info(`${this.batchLimit} files requested: ${this.incomingRequests.join(', ')}`);
        //     this.incomingRequests = [];
        // }

        logger.info(`File requested: ${archiveName} ${fileIndex}`);

        let file: Group | File = archive.groups.get(String(fileIndex));
        if(file) {
            if(!file.compressed) {
                // file.compress();
            }
            if(!file.empty) {
                const fileDataCopy = new ByteBuffer(file.data.length);
                file.data.copy(fileDataCopy, 0, 0);
                return this.createFileResponse(fileRequest, fileDataCopy);
            }
        }

        // logger.error(`File ${fileIndex} in index ${indexName} is empty.`);
        return null;
    }

    protected createFileResponse(fileRequest: FileRequest, fileDataBuffer: ByteBuffer): Buffer | null {
        const { archiveIndex, fileIndex } = fileRequest;

        if(fileDataBuffer.length < 5) {
            logger.error(`File ${fileIndex} in index ${archiveIndex} is corrupt.`);
            return null;
        }

        const compression: number = fileDataBuffer.get('byte', 'unsigned');
        const length: number = fileDataBuffer.get('int', 'unsigned') + (compression === 0 ? 5 : 9);

        let buffer: ByteBuffer;

        try {
            buffer = new ByteBuffer((length - 2) + ((length - 2) / 511) + 8);
        } catch(error) {
            logger.error(`Invalid file length of ${length} detected.`);
            return null;
        }

        buffer.put(archiveIndex);
        buffer.put(fileIndex, 'short');

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

    protected generateArchiveIndexFile(archiveIndex: number): Buffer {
        const indexData = this.fileStore.getArchive(String(archiveIndex));
        const dataCopy = new ByteBuffer(indexData.data.length);
        indexData.data.copy(dataCopy, 0, 0);
        return this.createFileResponse({ archiveIndex: 255, fileIndex: archiveIndex }, indexData.data);
    }

    protected generateCrcTableFile(): Buffer {
        const crcTableCopy = new ByteBuffer(this.mainIndexFile.length);
        this.mainIndexFile.copy(crcTableCopy, 0, 0);
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
