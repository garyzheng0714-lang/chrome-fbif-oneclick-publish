import { extractFoodtalksContent } from './foodtalks/extractor.js';
import { processFoodtalksContent } from './foodtalks/content-processor.js';
import { processFoodtalksImages } from './foodtalks/image-processor.js';
import { publishFoodtalks } from './foodtalks/publish-api.js';

export const PLATFORM_ADAPTERS = [
  {
    id: 'foodtalks',
    name: 'FoodTalks',
    icon: '🧭',
    description: 'FoodTalks 资讯后台',
    publishUrl: 'https://admin-we.foodtalks.cn/#/radar/news/publish',
    extractor: extractFoodtalksContent,
    contentProcessor: processFoodtalksContent,
    imageProcessor: processFoodtalksImages,
    publishApi: publishFoodtalks
  }
];

export const PLATFORM_ADAPTER_MAP = Object.fromEntries(PLATFORM_ADAPTERS.map((item) => [item.id, item]));
