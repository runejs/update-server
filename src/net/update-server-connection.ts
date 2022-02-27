import { Socket } from 'net';
import { logger } from '@runejs/common';
import { SocketServer } from '@runejs/common/net';
import { ByteBuffer } from '@runejs/common/buffer';
import { UpdateServer } from '../update-server';
import { FileRequest } from './file-request';


export const CONNECTION_ACCEPTED = 0;
export const UNSUPPORTED_CLIENT_VERSION = 6;


export class UpdateServerConnection extends SocketServer {

    private readonly updateServer: UpdateServer;
    private fileRequests: FileRequest[] = [];

    public constructor(updateServer: UpdateServer,
                       gameServerSocket: Socket) {
        super(gameServerSocket);
        this.updateServer = updateServer;
    }

    public initialHandshake(buffer: ByteBuffer): boolean {
        logger.info(`initialHandshake, readable = ${buffer.readable}`);
        const clientVersion: number = buffer.get('int');
        const supportedVersion = this.updateServer.serverConfig.gameVersion;

        // send the handshake response to the client
        if(supportedVersion === 'any') {
            this.socket.write(Buffer.from([ CONNECTION_ACCEPTED ]));
            return true;
        } else {
            const responseCode: number = clientVersion === supportedVersion ? CONNECTION_ACCEPTED : UNSUPPORTED_CLIENT_VERSION;
            this.socket.write(Buffer.from([ responseCode ]));
            return responseCode === CONNECTION_ACCEPTED;
        }
    }

    public decodeMessage(buffer: ByteBuffer): void {
        while(buffer.readable >= 4) {
            const requestMethod = buffer.get('byte', 'u'); // 0, 1, 2, 3, or 4
            const archiveIndex = buffer.get('byte', 'u');
            const fileIndex = buffer.get('short', 'u');

            if(requestMethod >= 4) {
                // error
                return;
            }

            if(requestMethod >= 2) {
                // clear queue
                this.fileRequests = [];
                break;
            }

            const archiveName = archiveIndex === 255 ? 'main' :
                this.updateServer.fileStore.get(archiveIndex).name

            const fileRequest: FileRequest = {
                archiveIndex, fileIndex, archiveName
            };

            if(requestMethod === 1) {
                this.sendFile(fileRequest);
            } else if(requestMethod === 0) {
                this.fileRequests.push(fileRequest);
            }
        }

        this.sendQueuedFiles();
    }

    public connectionDestroyed(): void {
        this.fileRequests = [];
    }

    protected sendQueuedFiles(): void {
        if(!this.fileRequests.length) {
            return;
        }

        const fileRequests = [ ...this.fileRequests ];
        this.fileRequests = [];

        for(const fileRequest of fileRequests) {
            this.sendFile(fileRequest);
        }
    }

    protected sendFile(fileRequest: FileRequest): void {
        if(!this.connectionAlive) {
            return;
        }

        const requestedFile = this.updateServer.handleFileRequest(fileRequest);

        if(this.socket && !this.socket.destroyed && this.socket.writable) {
            if(requestedFile) {
                this.socket.write(requestedFile);
            } else {
                logger.error(`Unable to find file ${fileRequest.fileIndex} in archive ${fileRequest.archiveName}.`);
                // this.socket.write(this.generateEmptyFile(fileRequest,
                //     StoreConfig.archives.get(String(fileRequest.archiveIndex)).versioned ? 0 : undefined));
            }
        }
    }

}
