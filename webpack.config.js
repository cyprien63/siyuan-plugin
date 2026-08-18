/**
 * Webpack build configuration for the SiYuan GitHub Sync plugin.
 *
 * - Development mode (`npm run dev`)  : watch mode, output written to the repo
 *   root so it can be symlinked directly into a SiYuan `data/plugins/` folder.
 * - Production mode (`npm run build`) : minified bundle written to `dist/`.
 *
 * The plugin is bundled as a CommonJS2 module (SiYuan loads plugins with
 * `require()`), and the `siyuan` package is kept external because SiYuan
 * provides it at runtime.
 */
const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => {
    const production = argv.mode === "production";

    const outputDir = production ? "dist" : ".";

    const plugins = [
        // Extract the compiled Sass/CSS into a single `index.css`.
        new MiniCssExtractPlugin({
            filename: "index.css",
        }),
        // Copy the static assets required by SiYuan's marketplace/bazaar.
        new CopyPlugin({
            patterns: [
                { from: "plugin.json", to: "." },
                {
                    from: "src/i18n",
                    to: "i18n/",
                    noErrorOnMissing: true,
                },
                {
                    from: "icon.png",
                    to: ".",
                    noErrorOnMissing: true,
                },
                {
                    from: "preview.png",
                    to: ".",
                    noErrorOnMissing: true,
                },
                {
                    from: "README.md",
                    to: ".",
                    noErrorOnMissing: true,
                },
            ],
        }),
    ];

    return {
        mode: production ? "production" : "development",
        entry: {
            index: "./src/index.ts",
        },
        output: {
            filename: "index.js",
            path: path.resolve(__dirname, outputDir),
            libraryTarget: "commonjs2",
            libraryExport: "default",
        },
        externals: {
            // SiYuan is provided by the host application — do not bundle it
            siyuan: "siyuan",
        },
        resolve: {
            extensions: [".ts", ".js"],
            // Polyfill lightweight path usage that some WASM packages expect
            fallback: {
                path: require.resolve("path-browserify"),
                fs: false,
            },
        },
        // Enable async WebAssembly modules used by Argon2 WASM packages
        experiments: {
            asyncWebAssembly: true,
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    loader: "esbuild-loader",
                    options: {
                        target: "es2020",
                    },
                },
                {
                    test: /\.s[ac]ss$/i,
                    use: [
                        MiniCssExtractPlugin.loader,
                        "css-loader",
                        {
                            loader: "sass-loader",
                            options: {
                                // Use the modern Sass API
                                api: "modern",
                            },
                        },
                    ],
                },
                {
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins,
        // Inline source maps during development make debugging easier.
        devtool: production ? false : "inline-source-map",
        optimization: {
            minimize: production,
        },
    };
};
