//@ts-check

"use strict";

const { resolve: _resolve } = require("path");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const baseConfig = {
    mode: "none", // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
    target: "node",
    externals: {
        vscode: "commonjs vscode", // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
        // modules added here also need to be added in the .vscodeignore file
    },
    resolve: {
        extensions: [".ts", ".js"],
    },
    devtool: "nosources-source-map",
    infrastructureLogging: {
        level: "log", // enables logging required for problem matchers
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{
                    loader: "ts-loader",
                    options: {
                        'projectReferences': true,
                    }
                }],
            },
        ],
    },
};

// Config for extension source code (to be run in a Node-based context)
/** @type WebpackConfig */
const extensionConfig = {
    ...baseConfig,
    entry: "./client/src/extension.ts",
    output: {
        path: _resolve(__dirname, "dist"),
        filename: "client.js",
        libraryTarget: "commonjs2",
    },
};

const serverConfig = {
    ...baseConfig,
    target: "node",
    entry: "./server/src/server.ts",
    output: {
        path: _resolve(__dirname, "dist"),
        filename: "server.js",
        libraryTarget: "commonjs2",
    },
};

module.exports = [extensionConfig, serverConfig];