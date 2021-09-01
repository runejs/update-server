import { Socket } from 'net';
import { ByteBuffer } from '@runejs/core/buffer';
import { SocketServer } from '@runejs/core/net';
import { logger } from '@runejs/core';

import UpdateServer from '../update-server';
import { FileRequest } from './file-request';
import { getIndexName } from '../../../filestore';


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
        const clientVersion: number = buffer.get('int');
        const supportedVersion: number = this.updateServer.serverConfig.clientVersion;

        const responseCode: number = clientVersion === supportedVersion ? CONNECTION_ACCEPTED : UNSUPPORTED_CLIENT_VERSION;
        const success: boolean = responseCode === CONNECTION_ACCEPTED;

        // send the handshake response to the client
        this.socket.write(Buffer.from([ responseCode ]));

        return success;
    }

    public decodeMessage(buffer: ByteBuffer): void {
        while(buffer.readable >= 4) {
            const requestMethod = buffer.get('byte', 'u'); // 0, 1, 2, 3, or 4
            const indexId = buffer.get('byte', 'u');
            const fileId = buffer.get('short', 'u');

            if(requestMethod >= 4) {
                // error
                return;
            }

            if(requestMethod >= 2) {
                // clear queue
                this.fileRequests = [];
                break;
            }

            const fileRequest: FileRequest = { archiveIndex: indexId, fileIndex: fileId };

            if(requestMethod === 1) {
                try {
                    this.sendFile(fileRequest);
                } catch(error) {
                    logger.error(error);
                }
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
            try {
                this.sendFile(fileRequest);
            } catch(error) {
                logger.error(error);
            }
        }
    }

    protected sendFile(fileRequest: FileRequest): void {
        if(!this.connectionAlive) {
            return;
        }

        const requestedFile = this.updateServer.handleFileRequest(fileRequest);

        if(requestedFile) {
            this.socket.write(requestedFile);
        } else {
            throw new Error(`File ${fileRequest.fileIndex} in archive ${getIndexName(fileRequest.archiveIndex)} is missing.`);
            // ^^^ this should have already been logged up the chain, no need to do it again here
            // ^^^ just leaving for reference while testing
            // this.socket.write(this.generateEmptyFile(indexId, fileId));
        }
    }

}
