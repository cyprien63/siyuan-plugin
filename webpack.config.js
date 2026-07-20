const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");

module.exports = (env, argv) => {
    const production = argv.mode === "production";

    const plugins = [
        new MiniCssExtractPlugin({
            filename: production ? "dist/index.css" : "index.css",
        }),
        new CopyPlugin({
            patterns: [
                // Always copy the manifest
                { from: "plugin.json", to: production ? "./dist/" : "./" },
                // Copy i18n if present
                {
                    from: "src/i18n",
                    to: production ? "./dist/i18n/" : "./i18n/",
                    noErrorOnMissing: true,
                },
                // Copy icons if present
                {
                    from: "icon.png",
                    to: production ? "./dist/" : "./",
                    noErrorOnMissing: true,
                },
                {
                    from: "preview.png",
                    to: production ? "./dist/" : "./",
                    noErrorOnMissing: true,
                },
                {
                    from: "README.md",
                    to: production ? "./dist/" : "./",
                    noErrorOnMissing: true,
                },
            ],
        }),
    ];

    if (production) {
        plugins.push(
            new ZipPlugin({
                filename: "siyuan-github-sync.zip",
                path: path.resolve(__dirname, "dist"),
            })
        );
    }

    return {
        mode: production ? "production" : "development",
        entry: {
            index: "./src/index.ts",
        },
        output: {
            filename: production ? "dist/index.js" : "index.js",
            path: path.resolve(__dirname),
            libraryTarget: "commonjs2",
            libraryExport: "default",
        },
        externals: {
            // SiYuan is provided by the host application — do not bundle it
            siyuan: "siyuan",
        },
        resolve: {
            extensions: [".ts", ".js"],
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
        devtool: production ? false : "inline-source-map",
        optimization: {
            minimize: production,
        },
    };
};
