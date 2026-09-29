// Preload for spawned tests that need gtg's TTY branch: node --import this file.
Object.defineProperty(process.stdout, 'isTTY', { value: true });
