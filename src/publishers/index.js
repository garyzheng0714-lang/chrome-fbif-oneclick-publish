import { extractZhihuContent } from './zhihu/extractor.js';
import { processZhihuContent } from './zhihu/content-processor.js';
import { processZhihuImages } from './zhihu/image-processor.js';
import { publishZhihu } from './zhihu/publish-api.js';
import { PLATFORM_SPECS } from './shared/platform-specs.js';

import { extractXiaohongshuContent } from './xiaohongshu/extractor.js';
import { processXiaohongshuContent } from './xiaohongshu/content-processor.js';
import { processXiaohongshuImages } from './xiaohongshu/image-processor.js';
import { publishXiaohongshu } from './xiaohongshu/publish-api.js';

import { extractPlatformContent as extractToutiao } from './toutiao/extractor.js';
import { processPlatformContent as processToutiao } from './toutiao/content-processor.js';
import { processPlatformImages as processToutiaoImages } from './toutiao/image-processor.js';
import { publishPlatform as publishToutiao } from './toutiao/publish-api.js';

import { extractPlatformContent as extractBaijiahao } from './baijiahao/extractor.js';
import { processPlatformContent as processBaijiahao } from './baijiahao/content-processor.js';
import { processPlatformImages as processBaijiahaoImages } from './baijiahao/image-processor.js';
import { publishPlatform as publishBaijiahao } from './baijiahao/publish-api.js';

import { extractPlatformContent as extractBilibili } from './bilibili/extractor.js';
import { processPlatformContent as processBilibili } from './bilibili/content-processor.js';
import { processPlatformImages as processBilibiliImages } from './bilibili/image-processor.js';
import { publishPlatform as publishBilibili } from './bilibili/publish-api.js';

export const PLATFORM_ADAPTERS = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: '📕',
    description: '图文笔记发布页',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=article',
    extractor: extractXiaohongshuContent,
    contentProcessor: processXiaohongshuContent,
    imageProcessor: processXiaohongshuImages,
    publishApi: publishXiaohongshu
  },
  {
    id: 'zhihu',
    name: '知乎',
    icon: '🧠',
    description: '知乎专栏写作页',
    publishUrl: PLATFORM_SPECS.zhihu.publishUrl,
    extractor: extractZhihuContent,
    contentProcessor: processZhihuContent,
    imageProcessor: processZhihuImages,
    publishApi: publishZhihu
  },
  {
    id: 'toutiao',
    name: '今日头条',
    icon: '📰',
    description: '头条创作平台',
    publishUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    extractor: extractToutiao,
    contentProcessor: processToutiao,
    imageProcessor: processToutiaoImages,
    publishApi: publishToutiao
  },
  {
    id: 'baijiahao',
    name: '百家号',
    icon: '🧩',
    description: '百度百家号图文页',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    extractor: extractBaijiahao,
    contentProcessor: processBaijiahao,
    imageProcessor: processBaijiahaoImages,
    publishApi: publishBaijiahao
  },
  {
    id: 'bilibili',
    name: 'B站专栏',
    icon: '📺',
    description: 'Bilibili 专栏编辑页',
    publishUrl: 'https://member.bilibili.com/platform/upload/text/edit',
    extractor: extractBilibili,
    contentProcessor: processBilibili,
    imageProcessor: processBilibiliImages,
    publishApi: publishBilibili
  }
];

export const PLATFORM_ADAPTER_MAP = Object.fromEntries(PLATFORM_ADAPTERS.map((item) => [item.id, item]));
