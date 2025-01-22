import { logger } from '@runejs/common';
import { ByteBuffer } from '@runejs/common/buffer';
import { parseServerConfig, SocketServer } from '@runejs/common/net';
import {
    type IndexEntity,
    Store,
    type Archive,
    type Group,
    type IndexedFile,
} from '@runejs/store';
import type { FileRequest } from './net/file-request';
import type { UpdateServerConfig } from './config/update-server-config';
import { UpdateServerConnection } from './net/update-server-connection';

export class UpdateServer {
    public readonly serverConfig: UpdateServerConfig;
    public fileStore: Store;
    public mainIndexFile: Buffer;

    public constructor() {
        this.serverConfig = parseServerConfig<UpdateServerConfig>();

        if (!this.serverConfig.gameVersion) {
            throw new Error(
                'Update Server supported client version was not provided. ' +
                    'Please add clientVersion to your configuration file.',
            );
        }
    }

    public static async launch(): Promise<UpdateServer> {
        const updateServer = new UpdateServer();

        await updateServer.loadFileStore();

        SocketServer.launch<UpdateServerConnection>(
            'Update Server',
            updateServer.serverConfig.updateServerHost,
            updateServer.serverConfig.updateServerPort,
            (socket) => new UpdateServerConnection(updateServer, socket),
        );

        return updateServer;
    }

    public async loadFileStore(): Promise<void> {
        try {
            const start = Date.now();

            logger.info('Reading store archives...');

            this.fileStore = await Store.create(
                `${this.serverConfig.gameVersion}`,
                this.serverConfig.storePath,
            );

            /*StoreConfig.register(this.serverConfig.storePath, this.serverConfig.gameVersion);
            StoreConfig.loadArchiveConfig();

            const fileReadStart = Date.now();

            this.fileStore.readStore(false);

            const fileReadEnd = Date.now();
            const fileReadDuration = fileReadEnd - fileReadStart;

            logger.info(`Store file read completed in ${fileReadDuration / 1000} seconds.`);

            for(const [ , archive ] of this.fileStore.archives) {
                const compressionStart = Date.now();
                logger.info(`Compressing archive ${archive.name}...`);

                let changeCount = 0;

                for(const [ , group ] of archive.groups) {
                    const groupOriginalCrc = group.crc32;

                    group.compress();
                    group.generateCrc32();

                    if(groupOriginalCrc !== group.crc32) {
                        // logger.warn(`Group ${group.name ?? group.index} checksum has changed from ${groupOriginalCrc} to ${group.crc32}.`);
                        changeCount++;
                    }
                }

                if(changeCount) {
                    logger.warn(changeCount === 1 ? `1 file change was detected.` : `${changeCount} file changes were detected.`);
                }

                const originalCrc = archive.crc32;
                archive.compress();
                archive.generateCrc32();

                if(originalCrc !== archive.crc32) {
                    logger.warn(`Archive ${archive.name} checksum has changed from ${originalCrc} to ${archive.crc32}.`);
                    archive.indexData.crc32 = archive.crc32;
                }

                const compressionEnd = Date.now();
                const compressionDuration = compressionEnd - compressionStart;

                logger.info(`Archive ${archive.name} was compressed in ${compressionDuration / 1000} seconds.`);
            }

            this.fileStore.buildMainIndex(); // Only if compress = false on the readStore(compress) call
            this.mainIndexFile = this.fileStore.mainIndexData.toNodeBuffer();

            const end = Date.now();
            const duration = end - start;

            logger.info(`Archives loaded and compressed in ${duration / 1000} seconds.`);*/
        } catch (e) {
            logger.error(e);
        }
    }

    public handleFileRequest(fileRequest: FileRequest): Buffer | null {
        const { archiveIndex, fileIndex } = fileRequest;

        if (archiveIndex === 255) {
            return fileIndex === 255
                ? this.fileStore.data.toNodeBuffer()
                : this.fileStore.get(fileIndex).index.data;
        }

        const archive =
            archiveIndex === 255 ? null : this.fileStore.get(archiveIndex);

        const file: Group = archive.get(fileIndex);

        if (file?.data) {
            return this.createFileResponse(fileRequest, archive, file);
            // return file.wrap(); // @TODO lol still broken
        }
        logger.error(`File ${fileIndex} in archive ${archive.name} is empty.`);
        return null;
    }

    protected createFileResponse(
        fileRequest: FileRequest,
        archive: Archive,
        file: IndexedFile<IndexEntity>,
    ): Buffer | null {
        if ((file?.data?.length ?? 0) < 5) {
            logger.error(
                `File ${fileRequest.fileIndex} in archive ${archive.name} is corrupt.`,
            );
            return null;
        }

        const { archiveIndex, fileIndex } = fileRequest;

        file.data.readerIndex = 0;

        const fileCompression: number = file.data.get('byte');
        const fileSize: number =
            file.data.get('int', 'unsigned') + (fileCompression === 0 ? 5 : 9);

        const responsePacket = new ByteBuffer(
            fileSize - 2 + (fileSize - 2) / 511 + 8,
        );

        responsePacket.put(archiveIndex);
        responsePacket.put(fileIndex, 'short');

        let s = 3;
        for (let i = 0; i < fileSize; i++) {
            if (s === 512) {
                responsePacket.put(255);
                s = 1;
            }

            responsePacket.put(file.data.at(i));
            s++;
        }

        return responsePacket.flipWriter().toNodeBuffer();
    }

    protected generateArchiveIndexFile(archiveIndex: number): Buffer {
        return this.fileStore.get(archiveIndex).index.data;
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
}
