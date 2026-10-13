type PlaybackWindow = {
  opener: unknown;
  closed: boolean;
  location: { replace: (url: string) => void };
  close: () => void;
};

/** openEpisodePlayback（打开官方单集）：预留标签页，核验返回链接后跳转；取消或失败时关闭空白页。 */
export async function openEpisodePlayback({
  platform, episode, openWindow, resolve, isActive, onOpened,
}: {
  platform: string;
  episode: number;
  openWindow: () => PlaybackWindow | null;
  resolve: () => Promise<unknown>;
  isActive: () => boolean;
  onOpened: () => void;
}): Promise<string | null> {
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000) throw new Error("请输入有效的整数集号。");
  const tab = openWindow();
  if (tab) tab.opener = null;
  try {
    const value = await resolve();
    if (!isActive()) { tab?.close(); return null; }
    if (!value || typeof value !== "object") throw new Error("官方单集链接响应异常，请重试。");
    const result = value as Record<string, unknown>;
    if (result.episode !== episode || typeof result.url !== "string") throw new Error("返回的集数与请求不符，请重试。");
    const url = new URL(result.url);
    const valid = url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash && (
      (platform === "bilibili" && url.hostname === "www.bilibili.com" && /^\/bangumi\/play\/ep[1-9]\d*$/u.test(url.pathname)) ||
      (platform === "tencent" && url.hostname === "v.qq.com" && /^\/x\/cover\/[a-zA-Z0-9]{3,64}\/[a-zA-Z0-9]{3,64}\.html$/u.test(url.pathname)) ||
      (platform === "youku" && url.hostname === "v.youku.com" && /^\/v_show\/id_[a-zA-Z0-9=+-]{6,128}\.html$/u.test(url.pathname))
    );
    if (!valid) throw new Error("未取得有效的官方单集链接，请重试。");
    if (tab && !tab.closed) {
      tab.location.replace(url.href);
      onOpened();
    }
    return url.href;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
