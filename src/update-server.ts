import { logger, ByteBuffer } from '@runejs/common';
import { parseServerConfig, SocketServer } from '@runejs/common/net';
import { Store } from '@runejs/store';

import { FileRequest, UpdateServerConnection } from './net';
import { UpdateServerConfig } from './config';


export class UpdateServer {

    public readonly serverConfig: UpdateServerConfig;
    public fileStore: Store;
    public mainIndexFile: Buffer;

    public constructor() {
        this.serverConfig = parseServerConfig<UpdateServerConfig>();

        if(!this.serverConfig.gameVersion) {
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
        const start = Date.now();

        logger.info(`Reading store archives...`);

        this.fileStore = await Store.create(this.serverConfig.storeVersion, this.serverConfig.storePath);
        await this.fileStore.read(false, false);
        this.mainIndexFile = Buffer.from(this.fileStore.index.data);

        const end = Date.now();
        const duration = end - start;

        logger.info(`Archives loaded in ${duration / 1000} seconds.`);
    }

    public handleFileRequest(fileRequest: FileRequest): Buffer | null {
        const { archiveIndex, fileIndex, archiveName } = fileRequest;
        // logger.debug(`File Requested: ${archiveName} ${fileIndex}`);

        let fileData: ByteBuffer | Buffer | null;

        if(archiveIndex === 255) {
            fileData = fileIndex === 255 ? this.mainIndexFile :
                this.fileStore.get(fileIndex)?.index?.data || null;
        } else {
            fileData = this.fileStore.get(archiveIndex)?.get(fileIndex)?.index?.data || null;
        }

        if(!fileData?.length) {
            logger.warn(`File ${fileIndex} in ${archiveName} is empty.`);
            return null;
        }

        return this.createFilePacket(archiveIndex, fileIndex, Buffer.from(fileData));
    }

    protected createFilePacket(archiveIndex: number, fileIndex: number, fileData: Buffer): Buffer {
        if(archiveIndex === 255 && fileIndex === 255) {
            const packet = new ByteBuffer(fileData.length + 3);
            packet.put(255);
            packet.put(255, 'short');
            packet.putBytes(fileData);
            return packet.toNodeBuffer();
        }

        const fileCompression = fileData.readInt8();
        const fileSize = fileData.readUInt32BE(1) + (fileCompression === 0 ? 5 : 9);
        const packet = new ByteBuffer((fileSize - 2) + ((fileSize - 2) / 511) + 8);

        packet.put(archiveIndex);
        packet.put(fileIndex, 'short');

        let s = 3;
        for(let i = 0; i < fileSize; i++) {
            if(s === 512) {
                packet.put(255);
                s = 1;
            }

            packet.put(fileData.at(i));
            s++;
        }

        return packet.flipWriter().toNodeBuffer();
    }

}
