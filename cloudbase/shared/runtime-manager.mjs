import CloudBase from '@cloudbase/manager-node';

/** createRuntimeManager（本次调用管理客户端）：仅使用运行时临时凭证，不缓存账号或密钥。 */
export function createRuntimeManager() {
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  const token = process.env.TENCENTCLOUD_SESSIONTOKEN;
  if (!secretId || !secretKey || !token) throw new Error('运行时管理凭证缺失');
  return new CloudBase({ envId: 'guoman-d1goxm3hhb53752a4', region: 'ap-shanghai', secretId, secretKey, token });
}
