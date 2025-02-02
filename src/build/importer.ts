import GreybelAgentPkg from 'greybel-agent';
import { TranspilerParseResult } from 'greybel-transpiler';
import path from 'path';
import vscode, { ExtensionContext } from 'vscode';

import { createBasePath } from '../helper/create-base-path';
const { GreybelC2Agent, GreybelC2LightAgent } = GreybelAgentPkg;

export enum AgentType {
  C2 = 'headless',
  C2Light = 'message-hook'
}

export enum ImporterMode {
  Local = 'local',
  Public = 'public'
}

const IMPORTER_MODE_MAP = {
  [ImporterMode.Local]: 2,
  [ImporterMode.Public]: 0
};

type ImportItem = {
  ingameFilepath: string;
  content: string;
};

type ImportResult = {
  path: string;
  success: boolean;
};

export interface ImporterOptions {
  target: string;
  mode: ImporterMode;
  ingameDirectory: string;
  agentType: AgentType;
  result: TranspilerParseResult;
  extensionContext: ExtensionContext;
  autoCompile: boolean;
}

class Importer {
  private importRefs: Map<string, ImportItem>;
  private agentType: AgentType;
  private target: string;
  private ingameDirectory: string;
  private mode: ImporterMode;
  private extensionContext: ExtensionContext;
  private autoCompile: boolean;

  constructor(options: ImporterOptions) {
    this.target = options.target;
    this.ingameDirectory = options.ingameDirectory;
    this.importRefs = this.createImportList(options.target, options.result);
    this.agentType = options.agentType;
    this.mode = options.mode;
    this.extensionContext = options.extensionContext;
    this.autoCompile = options.autoCompile;
  }

  private createImportList(
    rootTarget: string,
    parseResult: TranspilerParseResult
  ): Map<string, ImportItem> {
    return Object.entries(parseResult).reduce<Map<string, ImportItem>>(
      (result, [target, code]) => {
        const ingameFilepath = createBasePath(rootTarget, target, '');

        result.set(target, {
          ingameFilepath,
          content: code
        });

        return result;
      },
      new Map()
    );
  }

  private getUsername(): PromiseLike<string> {
    const username = vscode.workspace
      .getConfiguration('greybel')
      .get<string>('createIngame.steamUser');

    if (username != null) {
      return Promise.resolve(username);
    }

    return vscode.window.showInputBox({
      title: 'Enter steam account name',
      ignoreFocusOut: true
    });
  }

  private getPassword(): PromiseLike<string> {
    return vscode.window.showInputBox({
      title: 'Enter steam password',
      ignoreFocusOut: true,
      password: true
    });
  }

  async createAgent(): Promise<any> {
    switch (this.agentType) {
      case AgentType.C2: {
        const refreshToken = await this.extensionContext.secrets.get(
          'greybel.steam.refreshToken'
        );

        return new GreybelC2Agent({
          connectionType: IMPORTER_MODE_MAP[this.mode],
          steamGuardGetter: async (domain, callback) => {
            const code = await vscode.window.showInputBox({
              title: `Enter steam guard code (send to ${domain})`,
              ignoreFocusOut: true,
              password: true
            });
            callback(code);
          },
          refreshToken,
          onSteamRefreshToken: (code: string) => {
            this.extensionContext.secrets.store(
              'greybel.steam.refreshToken',
              code
            );
          },
          credentialsGetter: async (label: string) => {
            if (label.includes('password')) {
              return await this.getPassword();
            }
            return await this.getUsername();
          }
        });
      }
      case AgentType.C2Light: {
        return new GreybelC2LightAgent();
      }
    }
  }

  async import(): Promise<ImportResult[]> {
    if (!Object.prototype.hasOwnProperty.call(IMPORTER_MODE_MAP, this.mode)) {
      throw new Error('Unknown import mode.');
    }

    const agent = await this.createAgent();
    const results: ImportResult[] = [];

    for (const item of this.importRefs.values()) {
      const isCreated = await agent.tryToCreateFile(
        this.ingameDirectory + path.posix.dirname(item.ingameFilepath),
        path.basename(item.ingameFilepath),
        item.content
      );

      if (isCreated) {
        console.log(`Imported ${item.ingameFilepath} successful`);
        results.push({ path: item.ingameFilepath, success: true });
      } else {
        console.log(`Importing of ${item.ingameFilepath} failed`);
        results.push({ path: item.ingameFilepath, success: false });
      }
    }

    if (this.autoCompile) {
      const rootRef = this.importRefs.get(this.target);
      const binaryFileName = path
        .basename(rootRef.ingameFilepath)
        .replace(/\.[^.]+$/, '');
      const builtDone = agent.tryToBuild(
        this.ingameDirectory + path.posix.dirname(rootRef.ingameFilepath),
        binaryFileName,
        rootRef.content
      );

      if (builtDone) {
        console.log(`Build done`);

        for (const item of this.importRefs.values()) {
          await agent.tryToRemoveFile(
            this.ingameDirectory + item.ingameFilepath
          );
        }
      } else {
        console.log(`Build failed`);
      }
    }

    await agent.dispose();

    return results;
  }
}

export const createImporter = async (
  options: ImporterOptions
): Promise<ImportResult[]> => {
  const importer = new Importer(options);
  return await importer.import();
};
