import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock @tauri-apps/api/core so components can be tested outside Tauri runtime.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event to avoid Tauri IPC dependency.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
