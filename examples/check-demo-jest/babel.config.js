// Jest runs TypeScript through Babel: types stripped, modules made CommonJS.
module.exports = {
	presets: ["@babel/preset-typescript"],
	plugins: ["@babel/plugin-transform-modules-commonjs"],
};
