import { parse } from "@babel/core";
import traverseFunc from "@babel/traverse";

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

export { types as t } from "@babel/core";

export { parse };

export type ParseResult = ReturnType<typeof parse>;

export const traverse = traverseFunc;

export type { SourceLocation } from "@babel/types";

export { declare } from "@babel/helper-plugin-utils";

export const babelPluginProposalDecorators = require("@babel/plugin-proposal-decorators");

export const babelPresetTypescript = require("@babel/preset-typescript");
