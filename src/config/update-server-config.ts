import { ServerConfigOptions } from '@runejs/common/net';


export interface UpdateServerConfig extends ServerConfigOptions {
    updateServerHost: string;
    updateServerPort: number;
    storeDir: string;
    clientVersion: number;
}

export const defaultConfig: Partial<UpdateServerConfig> = {
    storeDir: '../store',
    clientVersion: 435
};
