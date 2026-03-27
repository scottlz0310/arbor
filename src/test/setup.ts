import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock @tauri-apps/api/core so components can be tested outside Tauri runtime.
// Return a resolved Promise by default so any component that awaits invoke()
// works without errors; individual tests can override with mockResolvedValue.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

// Mock @tauri-apps/api/event to avoid Tauri IPC dependency.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
