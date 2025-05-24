/** @type {import('next').NextConfig} */
const nextConfig = {
    output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
    eslint: {
        ignoreDuringBuilds: true, // disables ESLint checks during builds
    },
}

module.exports = nextConfig