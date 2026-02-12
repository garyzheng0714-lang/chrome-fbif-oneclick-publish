export const PLATFORM_DEFINITIONS = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: '📕',
    description: '图文笔记发布页',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=article'
  },
  {
    id: 'zhihu',
    name: '知乎',
    icon: '🧠',
    description: '知乎专栏写作页',
    publishUrl: 'https://zhuanlan.zhihu.com/p/2005305520517572521/edit'
  },
  {
    id: 'toutiao',
    name: '今日头条',
    icon: '📰',
    description: '头条创作平台',
    publishUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish'
  },
  {
    id: 'baijiahao',
    name: '百家号',
    icon: '🧩',
    description: '百度百家号图文页',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit'
  },
  {
    id: 'bilibili',
    name: 'B站专栏',
    icon: '📺',
    description: 'Bilibili 专栏编辑页',
    publishUrl: 'https://member.bilibili.com/platform/upload/text/edit'
  }
];

export const PLATFORM_NAME_MAP = Object.fromEntries(
  PLATFORM_DEFINITIONS.map((platform) => [platform.id, platform.name])
);
