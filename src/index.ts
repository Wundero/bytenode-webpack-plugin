import Module from 'module';
import path from 'path';
import v8 from 'v8';

import { compileCode, compileElectronCode } from 'bytenode';
import type { Hook } from 'tapable';
import { ExternalsPlugin } from 'webpack';
import type { WebpackPluginInstance } from 'webpack';
import type { Source } from 'webpack-sources';
import WebpackVirtualModules from 'webpack-virtual-modules';

import { createLoaderCode } from './loader';
import { toRelativeImportPath } from './paths';
import type { Options, Prepared, PreprocessedEntry, PreprocessedOutput, ProcessedOptions } from './types';
import type { Compiler, EntryPoint, WebpackOptionsNormalized } from './types-normalized';

v8.setFlagsFromString('--no-lazy');

class BytenodeWebpackPlugin implements WebpackPluginInstance {

  private readonly name = 'BytenodeWebpackPlugin';
  private readonly options: Options;

  constructor(options: Partial<Options> = {}) {
    this.options = {
      compileAsModule: true,
      compileForElectron: false,
      debugLifecycle: false,
      debugLogs: false,
      keepSource: false,
      preventSourceMaps: true,
      silent: false,
      ...options,
    };
  }

  apply(compiler: Compiler): void {
    this.setupLifecycleLogging(compiler);

    this.debug('original options', {
      context: compiler.options.context,
      devtool: compiler.options.devtool,
      entry: compiler.options.entry,
      output: compiler.options.output,
    });

    const { entry, entryLoaders, externals, output, virtualModules } = this.processOptions(compiler.options);

    this.debug('processed options', {
      entry,
      entryLoaders,
      output,
      virtualModules,
    });

    compiler.options.entry = entry;
    compiler.options.output.filename = output.filename;

    if (this.options.preventSourceMaps) {
      this.log('Preventing source maps from being generated by changing "devtool" to false.');
      compiler.options.devtool = false;
    }

    // @ts-ignore: The plugin supports string[] but the type doesn't
    new ExternalsPlugin('commonjs', externals)
      .apply(compiler);

    new WebpackVirtualModules(virtualModules)
      .apply(compiler);

    this.debug('modified options', {
      devtool: compiler.options.devtool,
      entry: compiler.options.entry,
      output: compiler.options.output,
    });

    compiler.hooks.emit.tapPromise(this.name, async (compilation) => {
      const entryLoaderFiles: string[] = [];

      for (const entryLoader of entryLoaders) {
        const entryPoints = compilation.entrypoints as Map<string, EntryPoint>;
        const entryPoint = entryPoints.get(entryLoader);
        const files = entryPoint?.getFiles() ?? [];

        entryLoaderFiles.push(...files);
      }

      const outputExtensionRegex = new RegExp('\\' + output.extension + '$', 'i');
      const shouldCompile = (name: string): boolean => {
        return outputExtensionRegex.test(name) && !entryLoaderFiles.includes(name);
      };

      for (const [name, asset] of Object.entries(compilation.assets as Record<string, Source>)) {
        this.debug('emitting', name);

        if (!shouldCompile(name)) {
          continue;
        }

        let source = asset.source();

        if (this.options.compileAsModule) {
          source = Module.wrap(source as string);
        }

        const compiledAssetName = name.replace(outputExtensionRegex, '.jsc');
        this.debug('compiling to', compiledAssetName);

        const compiledAssetSource = this.options.compileForElectron
          ? await compileElectronCode(source)
          : await compileCode(source);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        compilation.assets[compiledAssetName] = {
          size: () => compiledAssetSource.length,
          source: () => compiledAssetSource,
        };

        if (!this.options.keepSource) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          delete compilation.assets[name];
        }
      }
    });
  }

  processOptions(options: WebpackOptionsNormalized): ProcessedOptions {
    const output = this.preprocessOutput(options);

    const entries: [string, string | string[]][] = [];
    const entryLoaders: string[] = [];
    const externals: string[] = [];
    const virtualModules: [string, string][] = [];

    for (const { entry, compiled, loader } of this.preprocessEntry(options)) {
      const entryName = output.name ?? entry.name;

      entries.push([entryName, loader.locations.map(e => e.location)]);
      entryLoaders.push(entryName);

      const { name } = compiled;

      const from = output.of(entryName);
      const to = output.of(name);

      let relativeImportPath = toRelativeImportPath(options.output.path, from, to);

      // Use absolute path to load the compiled file in dev mode due to how electron-forge handles
      // the renderer process code loading (by using a server and not directly from the file system).
      // This should be safe exactly because it will only be used in dev mode, so the app code will
      // never be relocated after compiling with webpack and before starting electron.
      if (options.target === 'electron-renderer' && options.mode === 'development') {
        relativeImportPath = path.resolve(options.output.path, 'renderer', relativeImportPath);
      }

      entries.push([name, entry.locations.map(e => e.location)]);
      externals.push(relativeImportPath);

      for (const e of loader.locations) {
        if (!e.dependency) {
          virtualModules.push([e.location, createLoaderCode(relativeImportPath)]);
        }
      }
    }

    return {
      entry: Object.fromEntries(entries),
      entryLoaders,
      externals,
      output,
      virtualModules: Object.fromEntries(virtualModules),
    };
  }

  preprocessOutput({ context, output }: WebpackOptionsNormalized): PreprocessedOutput {
    let filename: string = output?.filename ?? '[name].js';

    const { extension, name } = prepare(context, filename);
    const dynamic = /.*[[\]]+.*/.test(filename);

    filename = dynamic ? filename : '[name]' + extension;

    return {
      dynamic,
      extension,
      filename,
      name: dynamic ? undefined : name,
      of: name => filename.replace('[name]', name),
    };
  }

  preprocessEntry({ context, entry }: WebpackOptionsNormalized): PreprocessedEntry[] {
    let entries: [string | undefined, string | string[]][];

    if (typeof entry === 'function') {
      throw new Error('Entry as a function is not supported as of yet.');
    }

    if (typeof entry === 'string' || Array.isArray(entry)) {
      entries = [[undefined, entry]];
    } else {
      entries = Object.entries(entry);
    }

    return entries.map(([name, location]) => {
      const entry = prepare(context, location, name);
      const compiled = prepare(context, location, name, '.compiled');
      const loader = prepare(context, location, name, '.loader');

      return {
        compiled, entry, loader,
      };
    });
  }

  debug(title: unknown, data: unknown, ...rest: unknown[]): void {
    const { debugLogs, silent } = this.options;

    if (!debugLogs || silent) {
      return;
    }

    if (typeof data === 'object') {
      console.debug('');

      if (typeof title === 'string') {
        title = title.endsWith(':') ? title : `${title}:`;
      }
    }

    console.debug(title, data, ...rest);
  }

  log(...messages: unknown[]): void {
    if (this.options.silent) {
      return;
    }
    console.log(`[${this.name}]:`, ...messages);
  }

  setupLifecycleLogging(compiler: Compiler): void {
    const { debugLifecycle, silent } = this.options;

    if (!debugLifecycle || silent) {
      return;
    }

    setupHooksLogging(this.name, 'compiler', compiler.hooks as unknown as Record<string, Hook>);

    compiler.hooks.normalModuleFactory.tap(this.name, normalModuleFactory => {
      setupHooksLogging(this.name, 'normalModuleFactory', normalModuleFactory.hooks as unknown as Record<string, Hook>);
    });

    compiler.hooks.compilation.tap(this.name, compilation => {
      setupHooksLogging(this.name, 'compilation', compilation.hooks as unknown as Record<string, Hook>);
    });

    function setupHooksLogging(pluginName: string, type: string, hooks: Record<string, Hook>): void {
      for (const [name, hook] of Object.entries(hooks)) {
        try {
          hook.tap(pluginName, function () {
            console.debug(`[${pluginName}]: ${type} hook: ${name} (${arguments.length} arguments)`);
          });
        } catch (_) {
          // ignore when unable to tap
        }
      }
    }
  }
}

function prepare(context: string | undefined, location: string | string[] | { import: string } | { import: string }[], name?: string, suffix = ''): Prepared {
  const locationArray = Array.isArray(location) ? location : [location];

  const locations = locationArray
    .map(location => {
      if (typeof location === 'object' && location.import) {
        return location.import;
      } else if (typeof location === 'string') {
        return location;
      } else if (Array.isArray(location)) {
        return location;
      } else {
        throw new Error('Could not read entry location');
      }
    }).flat().map((location: string) => {
      const dependency = isDependency(location);

      if (dependency) {
        return {
          dependency,
          location,
        };
      }

      if (context && !path.isAbsolute(location)) {
        location = path.resolve(context, location);
      }

      const directory = path.dirname(location);
      const extension = path.extname(location);
      const basename = path.basename(location, extension) + suffix;
      const filename = basename + extension;

      location = path.join(directory, filename);

      return {
        basename,
        dependency,
        location,
      };
    });

  let basename = 'main' + suffix;

  if (locations.length === 1) {
    const [single] = locations;
    basename = single.basename ?? basename;
  }

  name = name ? name + suffix : basename;

  return {
    extension: '.js', locations, name,
  };

  function isDependency(module: string): boolean {
    if (path.isAbsolute(module) || /^[.]+\/.*/.test(module)) {
      return false;
    }

    try {
      return typeof require.resolve(module) === 'string';
    } catch (_) {
      return false;
    }
  }
}

export {
  BytenodeWebpackPlugin,
};
