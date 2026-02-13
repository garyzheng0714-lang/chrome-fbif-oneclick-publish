export async function processZhihuImages(payload = {}) {
  // 需要登录态 cookie，图片上传放到页面上下文处理。
  return {
    ...payload,
    imageStrategy: 'zhihu-uploaded-images-api'
  };
}
