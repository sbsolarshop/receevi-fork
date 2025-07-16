/** @type {import('next').NextConfig} */
const nextConfig = {
    output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
    eslint: {
        ignoreDuringBuilds: true, // disables ESLint checks during builds
    },
    // Prevent attempting to initialize the cleanup worker during build
    serverRuntimeConfig: {
        isBuilding: process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV
    }
}

module.exports = nextConfig