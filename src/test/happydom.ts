// bun test には DOM 実装がないため、happy-dom をグローバル登録する。
// setup.ts (React Testing Library を import する) より先に preload されること。
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

// React 19 は act() の使用可否をこのフラグで判定する
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
