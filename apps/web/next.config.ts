import type {NextConfig} from 'next';
const config:NextConfig={poweredByHeader:false,transpilePackages:['@unai/auth','@unai/postgres','@unai/domain'],
  webpack(config){config.resolve.extensionAlias={...config.resolve.extensionAlias,'.js':['.ts','.tsx','.js']};return config;}};
export default config;
