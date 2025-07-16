declare global {
    namespace NodeJS {
        interface ProcessEnv {
            JWT_SECRET_KEY: string;
            FACEBOOK_APP_SECRET: string;
            WHATSAPP_ACCESS_TOKEN: string;
            SUPABASE_ANON_KEY: string;
            SUPABASE_URL: string;
            SUPABASE_SERVICE_ROLE: string;
            WEBHOOK_VERIFY_TOKEN: string;
            WHATSAPP_API_PHONE_NUMBER_ID: string;
            WHATSAPP_BUSINESS_ACCOUNT_ID: string;
            MEDIA_RETENTION_DAYS?: string;
        }
    }
}

export {}