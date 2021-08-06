import { Socket } from 'net';
import { ByteBuffer } from '@runejs/core/buffer';
import { SocketServer } from '@runejs/core/net';

import UpdateServer from '../update-server';
import { FileRequest } from './file-request';
import { ConnectionStage } from './connection-stage';


export class UpdateServerConnection extends SocketServer {

    private readonly updateServer: UpdateServer;

    private connectionStage: ConnectionStage = ConnectionStage.HANDSHAKE;
    private fileRequests: FileRequest[] = [];

    public constructor(updateServer: UpdateServer,
                       gameServerSocket: Socket) {
        super(gameServerSocket);
        this.updateServer = updateServer;
    }

    public initialHandshake(buffer: ByteBuffer): boolean {
        const gameVersion = buffer.get('int');

        const outputBuffer = new ByteBuffer(1);

        if(gameVersion === 435) {
            this.connectionStage = ConnectionStage.ACTIVE;
            outputBuffer.put(0); // good to go!
            this.socket.write(outputBuffer);
            return true;
        } else {
            outputBuffer.put(6); // out of date (incorrect client version number)
            this.socket.write(outputBuffer);
            return false;
        }
    }

    public async decodeMessage(buffer: ByteBuffer): Promise<void> {
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

            const fileRequest: FileRequest = { indexId, fileId };

            if(requestMethod === 1) {
                await this.sendFile(fileRequest);
            } else if(requestMethod === 0) {
                this.fileRequests.push(fileRequest);
            }
        }

        if(this.fileRequests.length > 0) {
            await this.sendQueuedFiles();
        }
    }

    public connectionDestroyed(): void {
        this.fileRequests = [];
    }

    protected async sendQueuedFiles(): Promise<void> {
        while(this.fileRequests.length > 0) {
            await this.sendFile(this.fileRequests.shift());
        }
    }

    protected async sendFile(fileRequest: FileRequest): Promise<void> {
        if(!this.connectionAlive) {
            return;
        }

        const requestedFile = await this.updateServer.handleFileRequest(fileRequest);

        if(requestedFile) {
            this.socket.write(requestedFile);
        } else {
            // logger.error(`File ${fileId} in archive ${getIndexName(indexId)} is missing.`);
            // ^^^ this should have already been logged up the chain, no need to do it again here
            // ^^^ just leaving for reference while testing
            // this.socket.write(this.generateEmptyFile(indexId, fileId));
        }
    }

}
