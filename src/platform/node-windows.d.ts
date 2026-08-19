/**
 * Minimal ambient types for node-windows (the package ships no declarations).
 * Only the surface used by WindowsPlatformService is modelled.
 */
declare module 'node-windows' {
  export interface ServiceOptions {
    name: string;
    description?: string;
    script?: string;
    nodeOptions?: string[];
    maxRetries?: number;
    wait?: number;
    grow?: number;
    startMode?: string;
    workingDirectory?: string;
    logOnAs?: unknown;
  }

  export class Service {
    constructor(opts: ServiceOptions);
    exists(): void;
    install(): void;
    uninstall(): void;
    start(): void;
    stop(): void;
    on(event: string, cb: (arg?: unknown) => void): void;
  }
}