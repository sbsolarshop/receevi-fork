-- Migration for automated media cleanup system
-- This will be automatically applied when you deploy the project

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Table to store cleanup configurations
CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default configuration (read from environment variable if available)
DO $$
DECLARE
  retention_days INT;
BEGIN
  -- Try to get retention days from environment
  BEGIN
    SELECT NULLIF(current_setting('app.media_retention_days', true), '')::INT INTO retention_days;
  EXCEPTION WHEN OTHERS THEN
    retention_days := 30; -- Default to 30 days if not set
  END;

  INSERT INTO public.system_config (key, value, description)
  VALUES (
    'media_retention',
    jsonb_build_object(
      'days', retention_days,
      'enabled', true
    ),
    'Configuration for media file retention and cleanup'
  ) ON CONFLICT (key) DO NOTHING;
END $$;

-- Function to process the cleanup queue
CREATE OR REPLACE FUNCTION public.process_media_cleanup()
RETURNS void AS $$
DECLARE
  retention_days INTEGER;
  cleanup_cutoff TIMESTAMPTZ;
  media_paths TEXT[];
  message_ids INTEGER[];
  log_id INTEGER;
BEGIN
  -- Get configuration
  SELECT (value->>'days')::int INTO retention_days FROM public.system_config WHERE key = 'media_retention';
  
  -- Default to 30 days if no configuration
  IF retention_days IS NULL THEN
    retention_days := 30;
  END IF;
  
  cleanup_cutoff := NOW() - (retention_days || ' days')::INTERVAL;
  
  RAISE NOTICE 'Starting media cleanup for files older than %', cleanup_cutoff;
  
  -- Create log entry
  INSERT INTO public.system_logs (action, details)
  VALUES (
    'media_cleanup_started',
    jsonb_build_object(
      'retention_days', retention_days,
      'cleanup_cutoff', cleanup_cutoff
    )
  ) RETURNING id INTO log_id;
  
  -- Identify messages with media to clean up
  WITH messages_to_clean AS (
    SELECT id, media_url
    FROM public.messages
    WHERE 
      created_at < cleanup_cutoff
      AND media_url IS NOT NULL
  )
  SELECT 
    ARRAY_AGG(media_url),
    ARRAY_AGG(id)
  INTO 
    media_paths,
    message_ids
  FROM messages_to_clean;
  
  -- If no media to clean, exit early
  IF media_paths IS NULL OR array_length(media_paths, 1) IS NULL THEN
    UPDATE public.system_logs 
    SET details = details || jsonb_build_object('files_found', 0, 'status', 'no_files')
    WHERE id = log_id;
    
    RETURN;
  END IF;
  
  -- Create queue table if it doesn't exist
  CREATE TABLE IF NOT EXISTS public.storage_cleanup_queue (
    id SERIAL PRIMARY KEY,
    storage_bucket TEXT NOT NULL,
    file_path TEXT NOT NULL,
    message_id INTEGER,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT
  );
  
  -- Queue files for deletion
  WITH unnested AS (
    SELECT unnest(media_paths) as path, unnest(message_ids) as msg_id
  )
  INSERT INTO public.storage_cleanup_queue (storage_bucket, file_path, message_id)
  SELECT 'media', path, msg_id FROM unnested;
  
  -- Update message records to clear media references
  UPDATE public.messages
  SET media_url = NULL
  WHERE id = ANY(message_ids);
  
  -- Update log entry
  UPDATE public.system_logs 
  SET details = details || jsonb_build_object(
    'files_found', array_length(media_paths, 1),
    'files_queued', array_length(media_paths, 1),
    'status', 'queued'
  )
  WHERE id = log_id;
  
  RAISE NOTICE 'Media cleanup: % files queued for deletion', array_length(media_paths, 1);
END;
$$ LANGUAGE plpgsql;

-- Create system logs table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.system_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schedule the cleanup function to run daily
SELECT cron.schedule('cleanup_media', '0 1 * * *', 'SELECT public.process_media_cleanup()');

-- Create a function for workers to process the queue
CREATE OR REPLACE FUNCTION public.fetch_storage_cleanup_batch(batch_size INTEGER DEFAULT 50)
RETURNS TABLE(id INTEGER, storage_bucket TEXT, file_path TEXT) AS $$
BEGIN
  RETURN QUERY
  WITH updated AS (
    UPDATE public.storage_cleanup_queue
    SET requested_at = NOW()
    WHERE id IN (
      SELECT id FROM public.storage_cleanup_queue
      WHERE completed_at IS NULL AND error IS NULL
      ORDER BY requested_at
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, storage_bucket, file_path
  )
  SELECT id, storage_bucket, file_path FROM updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark a cleanup task as complete
CREATE OR REPLACE FUNCTION public.mark_storage_cleanup_complete(task_id INTEGER, error_message TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
  UPDATE public.storage_cleanup_queue
  SET 
    completed_at = NOW(),
    error = error_message
  WHERE id = task_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get current media retention settings
CREATE OR REPLACE FUNCTION public.get_media_retention_days()
RETURNS INTEGER AS $$
DECLARE
  days INTEGER;
BEGIN
  SELECT (value->>'days')::int INTO days FROM public.system_config WHERE key = 'media_retention';
  RETURN COALESCE(days, 30);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update media retention settings
CREATE OR REPLACE FUNCTION public.set_media_retention_days(new_days INTEGER)
RETURNS VOID AS $$
BEGIN
  INSERT INTO public.system_config (key, value, description)
  VALUES (
    'media_retention',
    jsonb_build_object('days', new_days, 'enabled', true),
    'Configuration for media file retention and cleanup'
  )
  ON CONFLICT (key) DO UPDATE
  SET value = jsonb_build_object('days', new_days, 'enabled', true),
      updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant appropriate permissions
GRANT EXECUTE ON FUNCTION public.process_media_cleanup() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.fetch_storage_cleanup_batch(INTEGER) TO postgres, service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_storage_cleanup_complete(INTEGER, TEXT) TO postgres, service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.get_media_retention_days() TO postgres, service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.set_media_retention_days(INTEGER) TO postgres, service_role;
