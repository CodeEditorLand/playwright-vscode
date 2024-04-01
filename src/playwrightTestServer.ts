/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import { ConfigFindRelatedTestFilesReport, ConfigListFilesReport } from './listTests';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import { TeleReporterReceiver } from './upstream/teleReceiver';
import { TestServerConnection } from './upstream/testServerConnection';
import { startBackend } from './backend';
import type { PlaywrightTestOptions, PlaywrightTestRunOptions, TestConfig } from './playwrightTestTypes';
import { escapeRegex, pathSeparator } from './utils';
import { debugSessionName } from './debugSessionName';

export class PlaywrightTestServer {
  private _vscode: vscodeTypes.VSCode;
  private _options: PlaywrightTestOptions;
  private _config: TestConfig;
  private _testServerPromise: Promise<TestServerConnection | null> | undefined;

  constructor(vscode: vscodeTypes.VSCode, config: TestConfig, options: PlaywrightTestOptions) {
    this._vscode = vscode;
    this._config = config;
    this._options = options;
  }

  reset() {
    this._disposeTestServer();
  }

  async listFiles(): Promise<ConfigListFilesReport> {
    const testServer = await this._testServer();
    if (!testServer)
      throw new Error('Internal error: unable to connect to the test server');

    const result: ConfigListFilesReport = {
      projects: [],
    };

    // TODO: remove ConfigListFilesReport and report suite directly once CLI is deprecated.
    const { report } = await testServer.listFiles({});
    const teleReceiver = new TeleReporterReceiver({
      onBegin(rootSuite) {
        for (const projectSuite of rootSuite.suites) {
          const project = projectSuite.project()!;
          const files: string[] = [];
          result.projects.push({
            name: project.name,
            testDir: project.testDir,
            use: project.use || {},
            files,
          });
          for (const fileSuite of projectSuite.suites)
            files.push(fileSuite.location!.file);
        }
      },
      onError(error) {
        result.error = error;
      },
    }, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    for (const message of report)
      teleReceiver.dispatch(message);
    return result;
  }

  async listTests(locations: string[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const testServer = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!testServer)
      return;
    // Locations are regular expressions.
    locations = locations.map(escapeRegex);
    const { report } = await testServer.listTests({ locations });
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    for (const message of report)
      teleReceiver.dispatch(message);
  }

  async runTests(locations: string[], options: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const testServer = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!testServer)
      return;
    // Locations are regular expressions.
    locations = locations.map(escapeRegex);
    testServer.runTests({ locations, ...options });
    token.onCancellationRequested(() => {
      testServer.stopTestsNoReply({});
    });
    const disposable = testServer.onStdio(params => {
      if (params.type === 'stdout')
        reporter.onStdOut?.(unwrapString(params));
      if (params.type === 'stderr')
        reporter.onStdErr?.(unwrapString(params));
    });
    await this._wireTestServer(testServer, reporter, token);
    disposable.dispose();
  }

  async debugTests(locations: string[], testDirs: string[], options: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const configFolder = path.dirname(this._config.configFile);
    const configFile = path.basename(this._config.configFile);
    const args = ['test-server', '-c', configFile];

    const addressPromise = new Promise<string>(f => {
      const disposable = this._options.onStdOut(output => {
        const match = output.match(/Listening on (.*)/);
        if (match) {
          disposable.dispose();
          f(match[1]);
        }
      });
    });

    let testServer: TestServerConnection | undefined;
    let disposable: vscodeTypes.Disposable | undefined;
    try {
      await this._vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: configFolder,
        env: {
          ...process.env,
          CI: this._options.isUnderTest ? undefined : process.env.CI,
          ...this._options.envProvider(),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PWDEBUG: 'console',
        },
        program: this._config.cli,
        args,
      });

      if (token?.isCancellationRequested)
        return;
      const address = await addressPromise;
      testServer = new TestServerConnection(address);
      await testServer.connect();
      await testServer.setSerializer({ serializer: require.resolve('./oopReporter') });
      if (token?.isCancellationRequested)
        return;

      // Locations are regular expressions.
      locations = locations.map(escapeRegex);
      testServer.runTests({ locations, ...options });
      token.onCancellationRequested(() => {
        testServer!.stopTestsNoReply({});
      });
      disposable = testServer.onStdio(params => {
        if (params.type === 'stdout')
          reporter.onStdOut?.(unwrapString(params));
        if (params.type === 'stderr')
          reporter.onStdErr?.(unwrapString(params));
      });
      const testEndPromise = this._wireTestServer(testServer, reporter, token);
      await testEndPromise;
    } finally {
      disposable?.dispose();
      testServer?.closeGracefully({});
      await this._options.runHooks.onDidRunTests(true);
    }
  }

  async findRelatedTestFiles(files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const testServer = await this._testServer();
    if (!testServer)
      return { testFiles: files, errors: [{ message: 'Internal error: unable to connect to the test server' }] };
    return await testServer.findRelatedTestFiles({ files });
  }

  private _testServer() {
    if (this._testServerPromise)
      return this._testServerPromise;
    this._testServerPromise = this._createTestServer();
    return this._testServerPromise;
  }

  private async _createTestServer(): Promise<TestServerConnection | null> {
    const args = [this._config.cli, 'test-server', '-c', this._config.configFile];
    const wsEndpoint = await startBackend(this._vscode, {
      args,
      cwd: this._config.workspaceFolder,
      envProvider: () => {
        return {
          ...this._options.envProvider(),
          FORCE_COLOR: '1',
        };
      },
      dumpIO: false,
      onClose: () => {
        this._testServerPromise = undefined;
      },
      onError: error => {
        this._testServerPromise = undefined;
      },
    });
    if (!wsEndpoint)
      return null;
    const testServer = new TestServerConnection(wsEndpoint);
    await testServer.connect();
    await testServer.setInterceptStdio({ intercept: true });
    await testServer.setSerializer({ serializer: require.resolve('./oopReporter') });
    return testServer;
  }

  private async _wireTestServer(testServer: TestServerConnection, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    return new Promise<void>(resolve => {
      const disposable = testServer.onReport(message => {
        if (token.isCancellationRequested && message.method !== 'onEnd')
          return;
        teleReceiver.dispatch(message);
        if (message.method === 'onEnd') {
          disposable.dispose();
          resolve();
        }
      });
    });
  }

  private _disposeTestServer() {
    const testServer = this._testServerPromise;
    this._testServerPromise = undefined;
    if (testServer)
      testServer.then(server => server?.closeGracefully({}));
  }
}

function unwrapString(params: { text?: string, buffer?: string }): string | Buffer {
  return params.buffer ? Buffer.from(params.buffer, 'base64') : params.text || '';
}