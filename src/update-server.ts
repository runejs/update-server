import { logger, ByteBuffer } from '@runejs/common';
import { parseServerConfig, SocketServer } from '@runejs/common/net';
import { Filestore, readIndexedDataChunk } from '@runejs/filestore';
import type { Socket } from 'node:net';
import * as CRC32 from 'crc-32';

interface ServerConfig {
    updateServerHost: string;
    updateServerPort: number;
    cacheDir: string;
    configDir?: string;
}

enum ConnectionStage {
    HANDSHAKE = 'handshake',
    ACTIVE = 'active',
}

class UpdateServerConnection extends SocketServer {
    private connectionStage: ConnectionStage = ConnectionStage.HANDSHAKE;
    private files: { file: number; index: number }[] = [];

    public constructor(
        private readonly updateServer: UpdateServer,
        gameServerSocket: Socket,
    ) {
        super(gameServerSocket);
    }

    public initialHandshake(buffer: ByteBuffer): boolean {
        const gameVersion = buffer.get('INT');
        const outputBuffer = new ByteBuffer(1);

        if (gameVersion === 435) {
            outputBuffer.put(0); // good to go!
            this.connectionStage = ConnectionStage.ACTIVE;
            this.socket.write(outputBuffer);
            return true;
        }
        outputBuffer.put(6); // out of date
        this.socket.write(outputBuffer);
        return false;
    }

    public decodeMessage(buffer: ByteBuffer): void {
        while (buffer.readable >= 4) {
            const type = buffer.get('byte', 'u');
            const index = buffer.get('byte', 'u');
            const file = buffer.get('short', 'u');

            switch (type) {
                case 0: // queue
                    this.files.push({ index, file });
                    break;
                case 1: // immediate
                    this.socket.write(this.generateFile(index, file));
                    break;
                case 2:
                case 3: // clear queue
                    this.files = [];
                    break;
                case 4: // error
                    break;
            }

            while (this.files.length > 0) {
                const info = this.files.shift();
                this.socket.write(this.generateFile(info.index, info.file));
            }
        }
    }

    public connectionDestroyed(): void {}

    private generateFile(index: number, file: number): Buffer {
        let cacheFile: ByteBuffer;

        try {
            if (index === 255 && file === 255) {
                cacheFile = new ByteBuffer(this.updateServer.crcTable.length);
                this.updateServer.crcTable.copy(cacheFile, 0, 0);
            } else {
                cacheFile = readIndexedDataChunk(
                    file,
                    index,
                    this.updateServer.filestore.channels,
                ).dataFile;
            }
        } catch (error) {
            logger.warn(
                'Unable to load filestore file for update server request',
                index,
                file,
            );
        }

        if (!cacheFile || cacheFile.length === 0) {
            throw new Error(
                `Cache file not found; file(${file}) with index(${index}).`,
            );
        }

        const buffer = new ByteBuffer(
            cacheFile.length - 2 + (cacheFile.length - 2) / 511 + 8,
        );
        buffer.put(index, 'BYTE');
        buffer.put(file, 'SHORT');

        let length: number =
            (cacheFile.at(1, 'byte', 'u') << 24) +
            (cacheFile.at(2, 'byte', 'u') << 16) +
            (cacheFile.at(3, 'byte', 'u') << 8) +
            cacheFile.at(4, 'byte', 'u') +
            9;
        if (cacheFile.at(0) === 0) {
            length -= 4;
        }

        let c = 3;
        for (let i = 0; i < length; i++) {
            if (c === 512) {
                buffer.put(255, 'BYTE');
                c = 1;
            }

            buffer.put(cacheFile.at(i), 'BYTE');
            c++;
        }

        return Buffer.from(buffer.flipWriter());
    }
}

class UpdateServer {
    public readonly serverConfig: ServerConfig;
    public readonly filestore: Filestore;
    public readonly crcTable: ByteBuffer;

    public constructor(configDir?: string) {
        this.serverConfig = parseServerConfig<ServerConfig>({ configDir });

        this.filestore = new Filestore(this.serverConfig.cacheDir, {
            configDir:
                this.serverConfig.configDir || this.serverConfig.cacheDir,
            xteas: {},
        });
        this.crcTable = this.generateCrcTable();
    }

    private generateCrcTable(): ByteBuffer {
        const index = this.filestore.channels.metaChannel;
        const indexLength = index.length;
        const buffer = new ByteBuffer(4048);
        buffer.put(0, 'byte');
        buffer.put(indexLength, 'int');
        for (let file = 0; file < indexLength / 6; file++) {
            const crcValue = CRC32.buf(
                readIndexedDataChunk(file, 255, this.filestore.channels)
                    ?.dataFile,
            );
            buffer.put(crcValue, 'int');
        }

        return buffer;
    }
}

export const launchUpdateServer = (configDir?: string) => {
    const updateServer = new UpdateServer(configDir);
    const { updateServerHost, updateServerPort } = updateServer.serverConfig;
    SocketServer.launch<UpdateServerConnection>(
        'Update Server',
        updateServerHost,
        updateServerPort,
        (socket) => new UpdateServerConnection(updateServer, socket),
    );
};
