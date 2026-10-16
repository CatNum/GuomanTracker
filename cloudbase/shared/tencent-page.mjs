export const TENCENT_PAGE_API = 'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2&vversion_name=8.5.96';

/** Builds the existing public Tencent page request without performing network I/O. */
export function tencentPageRequest(params, context = {}) {
  const secondary = params.page_type === 'detail_operation';
  return {
    url: TENCENT_PAGE_API,
    platform: 'tencent',
    maxRedirects: 0,
    method: 'POST',
    body: JSON.stringify({
      page_params: { req_from: 'web_vsite', new_mark_label_enabled: '1', ...params },
      page_bypass_params: { params: { caller_id: '3000010', platform_id: '2', ...(secondary ? { page_type: 'detail_operation', page_id: 'vsite_episode_list', data_mode: 'default', user_mode: 'default' } : {}) }, scene: secondary ? 'operation' : 'desk_detail', app_version: '' },
      page_context: context,
    }),
  };
}
