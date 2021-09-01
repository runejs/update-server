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
    public indexFiles: Map<number, ByteBuffer> = new Map<number, ByteBuffer>();

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

            logger.info(`Generating main index file...`);
            this.crcTable = Buffer.from(await this.fileStore.generateCrcTable());

            const promises: Promise<void>[] = [];

            for(const [ index, archive ] of this.fileStore.indexedArchives) {
                if(!archive) {
                    continue;
                }

                const name = archive.archiveName;

                logger.info(`Loading files for archive ${name}...`);

                promises.push(archive.unpack(true, false).then(async () => {
                    logger.info(`${archive.files.size} file(s) loaded.`);
                    const indexFile = await archive.generateIndexFile();
                    this.indexFiles.set(index, indexFile);
                    logger.info(`${name} index file length: ${indexFile.length}`);
                }));
            }

            await Promise.all(promises);

            for(const [ , archive ] of this.fileStore.indexedArchives) {
                if(!archive) {
                    continue;
                }

                const name = archive.archiveName;
                const groupPromises: Promise<ByteBuffer>[] = [];

                logger.info(`Compressing ${name} archive groups...`);

                for(const [ , group ] of archive.files) {
                    if(group) {
                        groupPromises.push(group.compress());
                    }
                }

                const groupCount = (await Promise.all(groupPromises)).length;

                logger.info(`Compressed ${groupCount} groups.`);
            }

            const end = Date.now();
            const duration = end - start;

            logger.info(`File Store loaded in ${duration / 1000} seconds.`);
        } catch(e) {
            logger.error(e);
        }
    }

    public handleFileRequest(fileRequest: FileRequest): Buffer {
        const { archiveIndex, fileIndex } = fileRequest;

        if(archiveIndex === 255) {
            return fileIndex === 255 ? this.generateCrcTableFile() : this.generateArchiveIndexFile(fileIndex);
        }

        const indexedArchive = archiveIndex === 255 ? null : this.fileStore.indexedArchives.get(archiveIndex);
        const indexName: IndexName = getIndexName(archiveIndex);

        // this.incomingRequests.push(`${indexName} ${fileId}`);
        //
        // if(this.incomingRequests.length >= this.batchLimit) {
        //     logger.info(`${this.batchLimit} files requested: ${this.incomingRequests.join(', ')}`);
        //     this.incomingRequests = [];
        // }

        logger.info(`File requested: ${indexName} ${fileIndex}`);

        const indexedFile = indexedArchive.files.get(fileIndex);
        if(indexedFile) {
            if(!indexedFile.fileDataCompressed) {
                // await indexedFile.compress();
            }
            if(indexedFile.fileData) {
                const cacheFile = new ByteBuffer(indexedFile.fileData.length);
                indexedFile.fileData.copy(cacheFile, 0, 0);
                return this.createFileResponse(fileRequest, cacheFile);
            }
        }

        // logger.error(`File ${fileIndex} in index ${indexName} is empty.`);
        return null;
    }

    protected createFileResponse(fileRequest: FileRequest, fileDataBuffer: ByteBuffer): Buffer | null {
        const { archiveIndex, fileIndex } = fileRequest;

        const indexName: IndexName = getIndexName(archiveIndex);

        if(fileDataBuffer.length < 5) {
            logger.error(`File ${fileIndex} in index ${indexName} is corrupt.`);
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
        const indexFile = this.indexFiles.get(archiveIndex);
        const cacheFile = new ByteBuffer(indexFile.length);
        indexFile.copy(cacheFile, 0, 0);
        return this.createFileResponse({ archiveIndex: 255, fileIndex: archiveIndex }, indexFile);
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
