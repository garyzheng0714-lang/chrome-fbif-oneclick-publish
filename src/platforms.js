import { PLATFORM_ADAPTERS } from './publishers/index.js';

export const PLATFORM_DEFINITIONS = PLATFORM_ADAPTERS.map((platform) => ({
  id: platform.id,
  name: platform.name,
  icon: platform.icon,
  description: platform.description,
  publishUrl: platform.publishUrl
}));

export const PLATFORM_NAME_MAP = Object.fromEntries(
  PLATFORM_DEFINITIONS.map((platform) => [platform.id, platform.name])
);
