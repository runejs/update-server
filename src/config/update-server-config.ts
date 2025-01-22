import type { ServerConfigOptions } from '@runejs/common/net';


export interface UpdateServerConfig extends ServerConfigOptions {
    updateServerHost: string;
    updateServerPort: number;
    storePath: string;
    gameVersion: number;
}
