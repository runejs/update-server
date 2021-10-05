import { logger } from '@runejs/common';
import { Archive, File, Group, IndexedFileEntry } from '@runejs/filestore';
import { ByteBuffer } from '@runejs/common/buffer';
import { parseServerConfig, SocketServer } from '@runejs/common/net';
import { FlatFileStore } from '../../filestore';
import { FileRequest } from './net/file-request';
import { UpdateServerConfig } from './config/update-server-config';
import { UpdateServerConnection } from './net/update-server-connection';


export default class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: FlatFileStore;
    public mainIndexFile: Buffer;

    private incomingRequests: string[] = [];
    private batchLimit: number = 30;

    public constructor() {
        this.serverConfig = parseServerConfig<UpdateServerConfig>();

        if(!this.serverConfig.clientVersion) {
            throw new Error(`Update Server supported client version was not provided. ` +
                `Please add clientVersion to your configuration file.`);
        }
    }

    public static async launch(): Promise<UpdateServer> {
        const updateServer = new UpdateServer();

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
                gameVersion: this.serverConfig.clientVersion
            });

            logger.info(`Reading store archives...`);

            await this.fileStore.readStore(false);

            for(const [ , archive ] of this.fileStore.archives) {
                if(!archive?.index || archive.index === '255') {
                    continue;
                }

                const name = archive.name;
                const groupPromises: Promise<void>[] = [];

                logger.info(`Compressing groups for archive ${name}...`);

                for(const [ , group ] of archive.groups) {
                    if(group) {
                        groupPromises.push(new Promise<void>(resolve => {
                            group.compress();
                            resolve();
                        }));
                    }
                }

                const groupCount = (await Promise.all(groupPromises)).length;

                logger.info(`Compressed ${groupCount} groups.`);

                logger.info(`Compressing index file...`);

                await archive.generateJs5Index(true);

                const originalCrc = archive.crc32;
                archive.generateCrc32();

                if(originalCrc !== archive.crc32) {
                    // logger.warn(`Archive ${this.name} checksum has changed from ${originalCrc} to ${this.crc32}.`);
                    archive.indexData.crc32 = archive.crc32;
                }

                logger.info(`Archive ${name} compression complete.`);
            }

            this.fileStore.buildMainIndex();
            this.mainIndexFile = this.fileStore.mainIndexData.toNodeBuffer();

            const end = Date.now();
            const duration = end - start;

            logger.info(`Archives loaded: ` +
                Array.from(this.fileStore.archives.values()).map(a => a.name).join(', '),
                `File Store loaded in ${duration / 1000} seconds.`);
        } catch(e) {
            logger.error(e);
        }
    }

    public handleFileRequest(fileRequest: FileRequest): Buffer {
        const { archiveIndex, fileIndex } = fileRequest;

        if(archiveIndex === 255) {
            return fileIndex === 255 ? this.wrapMainIndexFile() : this.generateArchiveIndexFile(fileIndex);
        }

        const archive = archiveIndex === 255 ? null : this.fileStore.getArchive(String(archiveIndex));

        // logger.info(`File requested: ${archive.name} ${fileIndex}`);

        const file: Group | File = archive.groups.get(String(fileIndex));

        // if(file && !file.empty) {
        if(file?.data) {
            return this.createFileResponse(archive, file);
            // return file.wrap();
        } else {
            logger.error(`File ${fileIndex} in archive ${archive.name} is empty.`);
            // return this.generateEmptyFile(fileRequest,
            //     file.archive.config.versioned ? file.version ?? 0 : undefined)
        }

        return null;
    }

    protected versionFileData(file: Group): ByteBuffer {
        if(!file.archive.config.versioned) {
            return file.data;
        }

        const size = file.data.length + 2;
        const fileDataCopy = new ByteBuffer(size);
        file.data.copy(fileDataCopy, 0, 0);

        if(file.archive.config.versioned) {
            fileDataCopy.writerIndex = fileDataCopy.length - 2;
            fileDataCopy.put(file.version ?? 1, 'short');
        }

        return fileDataCopy.flipWriter();
    }

    protected createFileResponse(archive: Archive, file: IndexedFileEntry<any>): Buffer | null {
        const archiveIndex = archive.numericIndex;
        const fileIndex = file.numericIndex;

        let fileData: ByteBuffer;
        let versionSize = 2;

        if(file.data.length < 5) {
            logger.error(`File ${fileIndex} in archive ${archive.name} is malformed.`);
            return null;
        }

        if(file instanceof Group) {
            fileData = this.versionFileData(file);
            if(file.archive.config.versioned) {
                versionSize = 2;
            }
        } else {
            const a = file as Archive;
            fileData = new ByteBuffer(a.data.length);
            a.data.copy(fileData, 0, 0);
        }

        fileData.readerIndex = 0;
        // const fileCompression: number = fileData.get('byte');
        // const fileSize: number = fileData.get('int', 'unsigned') + (fileCompression === 0 ? 5 : 9);
        const fileSize = file.data.length;

        const responsePacket = new ByteBuffer((fileData.length - 2) + ((fileData.length - 2) / 511) + 8);

        responsePacket.put(archiveIndex);
        responsePacket.put(fileIndex, 'short');

        let s = 3;
        for(let i = 0; i < fileSize; i++) {
            if(s === 512) {
                responsePacket.put(255);
                s = 1;
            }

            responsePacket.put(fileData.at(i));
            s++;
        }

        return Buffer.from(responsePacket.flipWriter());
    }

    protected generateArchiveIndexFile(archiveIndex: number): Buffer {
        const indexData = this.fileStore.getArchive(String(archiveIndex));
        return this.createFileResponse(this.fileStore.getArchive('255'), indexData);
    }

    protected wrapMainIndexFile(): Buffer {
        const crcTableCopy = new ByteBuffer(this.mainIndexFile.length);
        this.mainIndexFile.copy(crcTableCopy, 0, 0);
        const crcFileBuffer = new ByteBuffer(86);
        crcFileBuffer.put(255);
        crcFileBuffer.put(255, 'short');
        crcFileBuffer.putBytes(crcTableCopy, 0, 83);
        return Buffer.from(crcFileBuffer);
    }

    protected generateEmptyFile(fileRequest: FileRequest, version?: number | undefined): Buffer {
        const buffer = new ByteBuffer(version !== undefined ? 11 : 9);
        buffer.put(fileRequest.archiveIndex);
        buffer.put(fileRequest.fileIndex, 'short');
        buffer.put(0); // compression
        buffer.put(1, 'int'); // file length
        buffer.put(0); // single byte of data

        if(version !== undefined) {
            buffer.put(0, 'short');
        }

        return buffer.toNodeBuffer();
    }

}
