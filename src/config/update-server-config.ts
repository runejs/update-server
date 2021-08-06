export interface UpdateServerConfig {
    updateServerHost: string;
    updateServerPort: number;
    storeDir: string;
    clientVersion: number;
}

export const defaultConfig: Partial<UpdateServerConfig> = {
    storeDir: '../filestore/stores',
    clientVersion: 435
};
