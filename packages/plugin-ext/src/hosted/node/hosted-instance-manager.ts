/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable, named } from 'inversify';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as request from 'request';

import URI from '@theia/core/lib/common/uri';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { LogType } from './../../common/types';
import { HostedPluginUriPostProcessor, HostedPluginUriPostProcessorSymbolName } from './hosted-plugin-uri-postprocessor';
import { HostedPluginSupport } from './hosted-plugin';
import { DebugConfiguration } from '../../common';
import { environment } from '@theia/core';
const processTree = require('ps-tree');

export const HostedInstanceManager = Symbol('HostedInstanceManager');

/**
 * Is responsible for running and handling separate Theia instance with given plugin.
 */
export interface HostedInstanceManager {
    /**
     * Checks whether hosted instance is run.
     */
    isRunning(): boolean;

    /**
     * Runs specified by the given uri plugin in separate Theia instance.
     *
     * @param pluginUri uri to the plugin source location
     * @param port port on which new instance of Theia should be run. Optional.
     * @returns uri where new Theia instance is run
     */
    run(pluginUri: URI, port?: number): Promise<URI>;

    /**
     * Runs specified by the given uri plugin  with debug in separate Theia instance.
     * @param pluginUri uri to the plugin source location
     * @param debugConfig debug configuration
     * @returns uri where new Theia instance is run
     */
    debug(pluginUri: URI, debugConfig: DebugConfiguration): Promise<URI>;

    /**
     * Terminates hosted plugin instance.
     * Throws error if instance is not running.
     */
    terminate(): void;

    /**
     * Returns uri where hosted instance is run.
     * Throws error if instance is not running.
     */
    getInstanceURI(): URI;

    /**
     * Returns uri where plugin loaded into hosted instance is located.
     * Throws error if instance is not running.
     */
    getPluginURI(): URI;

    /**
     * Checks whether given uri points to a valid plugin.
     *
     * @param uri uri to the plugin source location
     */
    isPluginValid(uri: URI): boolean;
}

const HOSTED_INSTANCE_START_TIMEOUT_MS = 30000;
const THEIA_INSTANCE_REGEX = /.*Theia app listening on (.*).*\./;
const PROCESS_OPTIONS = {
    cwd: process.cwd(),
    env: { ...process.env }
};
delete PROCESS_OPTIONS.env.ELECTRON_RUN_AS_NODE;

@injectable()
export abstract class AbstractHostedInstanceManager implements HostedInstanceManager {
    protected hostedInstanceProcess: cp.ChildProcess;
    protected processOptions: cp.SpawnOptions;
    protected isPluginRunnig: boolean = false;
    protected instanceUri: URI;
    protected pluginUri: URI;

    @inject(HostedPluginSupport)
    protected readonly hostedPluginSupport: HostedPluginSupport;

    isRunning(): boolean {
        return this.isPluginRunnig;
    }

    async run(pluginUri: URI, port?: number): Promise<URI> {
        return this.doRun(pluginUri, port);
    }

    async debug(pluginUri: URI, debugConfig: DebugConfiguration): Promise<URI> {
        return this.doRun(pluginUri, undefined, debugConfig);
    }

    private async doRun(pluginUri: URI, port?: number, debugConfig?: DebugConfiguration): Promise<URI> {
        if (this.isPluginRunnig) {
            this.hostedPluginSupport.sendLog({ data: 'Hosted plugin instance is already running.', type: LogType.Info });
            throw new Error('Hosted instance is already running.');
        }

        let command: string[];
        let processOptions: cp.SpawnOptions;
        if (pluginUri.scheme === 'file') {
            processOptions = { ...PROCESS_OPTIONS };
            if (processOptions.env) {
                processOptions.env.HOSTED_PLUGIN = pluginUri.path.toString();

                // Disable all the other plugins on this instance
                processOptions.env.THEIA_PLUGINS = '';
            }
            command = await this.getStartCommand(port, debugConfig);
        } else {
            throw new Error('Not supported plugin location: ' + pluginUri.toString());
        }

        this.instanceUri = await this.postProcessInstanceUri(
            await this.runHostedPluginTheiaInstance(command, processOptions));
        this.pluginUri = pluginUri;

        await this.checkInstanceUriReady();

        return this.instanceUri;
    }

    terminate(): void {
        if (this.isPluginRunnig) {
            // tslint:disable-next-line:no-any
            processTree(this.hostedInstanceProcess.pid, (err: Error, children: Array<any>) => {
                // tslint:disable-next-line:no-any
                const args = ['-SIGTERM', this.hostedInstanceProcess.pid.toString()].concat(children.map((p: any) => p.PID));
                cp.spawn('kill', args);
            });
            this.hostedPluginSupport.sendLog({ data: 'Hosted instance has been terminated', type: LogType.Info });
        } else {
            throw new Error('Hosted plugin instance is not running.');
        }
    }

    getInstanceURI(): URI {
        if (this.isPluginRunnig) {
            return this.instanceUri;
        }
        throw new Error('Hosted plugin instance is not running.');
    }

    getPluginURI(): URI {
        if (this.isPluginRunnig) {
            return this.pluginUri;
        }
        throw new Error('Hosted plugin instance is not running.');
    }

    /**
     * Checks that the `instanceUri` is responding before exiting method
     */
    public async checkInstanceUriReady(): Promise<void> {
        return new Promise<void>((resolve, reject) => this.pingLoop(60, resolve, reject));
    }

    /**
     * Start a loop to ping, if ping is OK return immediately, else start a new ping after 1second. We iterate for the given amount of loops provided in remainingCount
     * @param remainingCount the number of occurence to check
     * @param resolve resolvefunction if ok
     * @param reject reject function if error
     */
    private async pingLoop(remainingCount: number,
        resolve: (value?: void | PromiseLike<void> | undefined | Error) => void,
        reject: (value?: void | PromiseLike<void> | undefined | Error) => void): Promise<void> {
        const isOK = await this.ping();
        if (isOK) {
            resolve();
        } else {
            if (remainingCount > 0) {
                setTimeout(() => this.pingLoop(--remainingCount, resolve, reject), 1000);
            } else {
                reject(new Error('Unable to ping the remote server'));
            }
        }
    }

    /**
     * Ping the plugin URI (checking status of the head)
     */
    private async ping(): Promise<boolean> {
        // disable redirect to grab the release
        const options = {
            followRedirect: false
        };

        return new Promise<boolean>((resolve, reject) => {
            const url = this.instanceUri.toString();
            request.head(url, options).on('response', res => {
                // Wait that the status is OK
                if (res.statusCode === 200) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            }).on('error', error => {
                resolve(false);
            });
        });
    }

    isPluginValid(uri: URI): boolean {
        const packageJsonPath = uri.path.toString() + '/package.json';
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = require(packageJsonPath);
            const plugin = packageJson['theiaPlugin'];
            if (plugin && (plugin['frontend'] || plugin['backend'])) {
                return true;
            }
        }
        return false;
    }

    protected async getStartCommand(port?: number, debugConfig?: DebugConfiguration): Promise<string[]> {

        const processArguments = process.argv;
        let command: string[];
        if (environment.electron.is()) {
            command = ['yarn', 'theia', 'start'];
        } else {
            command = processArguments.filter(arg => {
                // remove --port= argument if set
                if (arg.startsWith('--port=')) {
                    return;
                } else {
                    return arg;
                }
            });
        }
        if (process.env.HOSTED_PLUGIN_HOSTNAME) {
            command.push('--hostname=' + process.env.HOSTED_PLUGIN_HOSTNAME);
        }
        if (port) {
            await this.validatePort(port);
            command.push('--port=' + port);
        }

        if (debugConfig) {
            let debugString = '--hosted-plugin-';
            if (debugConfig.debugMode) {
                debugString += debugConfig.debugMode;
            } else {
                debugString += 'inspect';
            }

            debugString += '=0.0.0.0';

            if (debugConfig.port) {
                debugString += ':' + debugConfig.port;
            }
            command.push(debugString);
        }
        return command;
    }

    protected async postProcessInstanceUri(uri: URI): Promise<URI> {
        return uri;
    }

    protected runHostedPluginTheiaInstance(command: string[], options: cp.SpawnOptions): Promise<URI> {
        this.isPluginRunnig = true;
        return new Promise((resolve, reject) => {
            let started = false;
            const outputListener = (data: string | Buffer) => {
                const line = data.toString();
                const match = THEIA_INSTANCE_REGEX.exec(line);
                if (match) {
                    this.hostedInstanceProcess.stdout.removeListener('data', outputListener);
                    started = true;
                    resolve(new URI(match[1]));
                }
            };

            this.hostedInstanceProcess = cp.spawn(command.shift()!, command, options);
            this.hostedInstanceProcess.on('error', () => { this.isPluginRunnig = false; });
            this.hostedInstanceProcess.on('exit', () => { this.isPluginRunnig = false; });
            this.hostedInstanceProcess.stdout.addListener('data', outputListener);

            this.hostedInstanceProcess.stdout.addListener('data', data => {
                this.hostedPluginSupport.sendLog({ data: data.toString(), type: LogType.Info });
            });
            this.hostedInstanceProcess.stderr.addListener('data', data => {
                this.hostedPluginSupport.sendLog({ data: data.toString(), type: LogType.Error });
            });

            setTimeout(() => {
                if (!started) {
                    this.terminate();
                    this.isPluginRunnig = false;
                    reject('Timeout.');
                }
            }, HOSTED_INSTANCE_START_TIMEOUT_MS);
        });
    }

    protected async validatePort(port: number): Promise<void> {
        if (port < 1 || port > 65535) {
            throw new Error('Port value is incorrect.');
        }

        if (! await this.isPortFree(port)) {
            throw new Error('Port ' + port + ' is already in use.');
        }
    }

    protected isPortFree(port: number): Promise<boolean> {
        return new Promise(resolve => {
            const server = net.createServer();
            server.listen(port, '0.0.0.0');
            server.on('error', () => {
                resolve(false);
            });
            server.on('listening', () => {
                server.close();
                resolve(true);
            });
        });
    }

}

@injectable()
export class NodeHostedPluginRunner extends AbstractHostedInstanceManager {
    @inject(ContributionProvider) @named(Symbol.for(HostedPluginUriPostProcessorSymbolName))
    protected readonly uriPostProcessors: ContributionProvider<HostedPluginUriPostProcessor>;

    protected async postProcessInstanceUri(uri: URI): Promise<URI> {
        for (const uriPostProcessor of this.uriPostProcessors.getContributions()) {
            uri = await uriPostProcessor.processUri(uri);
        }
        return uri;
    }

    protected async getStartCommand(port?: number, config?: DebugConfiguration): Promise<string[]> {
        if (!port) {
            if (process.env.HOSTED_PLUGIN_PORT) {
                port = Number(process.env.HOSTED_PLUGIN_PORT);
            } else {
                port = 3030;
            }
        }
        return super.getStartCommand(port, config);
    }

}

@injectable()
export class ElectronNodeHostedPluginRunner extends AbstractHostedInstanceManager {

}
