import { createClient } from '@supabase/supabase-js';
import { SupabaseClient } from '@supabase/supabase-js';

// Define the structure of a cleanup task
interface CleanupTask {
  id: number;
  storage_bucket: string;
  file_path: string;
}

// Configuration
const WORKER_INTERVAL = 60000; // 1 minute
const BATCH_SIZE = 50; // Number of files to process in each batch

/**
 * This worker processes the storage cleanup queue
 * It periodically checks for files that need to be deleted from storage
 * and handles their removal
 */
export class StorageCleanupWorker {
  private supabase;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  
  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
    
    // Validate environment variables
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Cannot initialize StorageCleanupWorker: ' +
        'Missing required environment variables ' +
        '(SUPABASE_URL and/or SUPABASE_SERVICE_ROLE)'
      );
    }
    
    // Initialize Supabase client
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }
  
  /**
   * Start the worker process
   */
  public start(): void {
    console.log('Storage cleanup worker: Starting...');
    
    // Clear any existing interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    // Process immediately on start
    this.processQueue();
    
    // Set up periodic processing
    this.intervalId = setInterval(() => this.processQueue(), WORKER_INTERVAL);
  }
  
  /**
   * Stop the worker process
   */
  public stop(): void {
    console.log('Storage cleanup worker: Stopping...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  /**
   * Process a batch of files from the cleanup queue
   */
  private async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Fetch a batch of files to process using raw query instead of RPC
      // This avoids TypeScript errors with custom RPC functions
      const { data: filesToProcess, error: fetchError } = await this.supabase
        .from('storage_cleanup_queue')
        .select('id, storage_bucket, file_path')
        .is('completed_at', null)
        .order('requested_at', { ascending: true })
        .limit(BATCH_SIZE);
      
      if (fetchError) {
        console.error('Storage cleanup worker: Error fetching cleanup batch:', fetchError);
        return;
      }
      
      if (!filesToProcess || filesToProcess.length === 0) {
        // No files to process, exit quietly
        return;
      }
      
      console.log(`Storage cleanup worker: Processing ${filesToProcess.length} files`);
      
      // Process each file
      for (const file of filesToProcess as CleanupTask[]) {
        try {
          // Delete the file from storage
          const { error: deleteError } = await this.supabase
            .storage
            .from(file.storage_bucket)
            .remove([file.file_path]);
          
          // Mark the task as complete using direct update instead of RPC
          if (deleteError) {
            console.error(`Storage cleanup worker: Failed to delete ${file.file_path}:`, deleteError);
            await this.supabase
              .from('storage_cleanup_queue')
              .update({
                completed_at: new Date().toISOString(),
                error: deleteError.message || JSON.stringify(deleteError)
              })
              .eq('id', file.id);
          } else {
            await this.supabase
              .from('storage_cleanup_queue')
              .update({
                completed_at: new Date().toISOString()
              })
              .eq('id', file.id);
            console.log(`Storage cleanup worker: Successfully deleted ${file.file_path}`);
          }
        } catch (e) {
          console.error(`Storage cleanup worker: Exception processing ${file.file_path}:`, e);
          
          // Mark the task as failed using direct update
          await this.supabase
            .from('storage_cleanup_queue')
            .update({
              completed_at: new Date().toISOString(),
              error: e instanceof Error ? e.message : 'Unknown error'
            })
            .eq('id', file.id);
        }
      }
    } catch (e) {
      console.error('Storage cleanup worker: Unexpected error:', e);
    } finally {
      // Log count of remaining items
      try {
        const { count } = await this.supabase
          .from('storage_cleanup_queue')
          .select('*', { count: 'exact', head: true })
          .is('completed_at', null);
        
        console.log(`Storage cleanup worker: ${count || 0} items remaining in queue`);
      } catch (countError) {
        console.error('Error counting remaining items:', countError);
      }
      
      this.isProcessing = false;
    }
  }
}

// Singleton instance
let cleanupWorker: StorageCleanupWorker | null = null;

/**
 * Initialize the storage cleanup worker
 * Should be called when your application starts
 */
export function initStorageCleanupWorker(): void {
  // Only initialize in server environment
  if (typeof window !== 'undefined') {
    console.log('Storage cleanup worker: Cannot initialize in browser environment');
    return;
  }
  
  // Check for required environment variables
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    console.log('Storage cleanup worker: Missing required environment variables');
    return;
  }
  
  try {
    // Create and start the worker if it doesn't exist
    if (!cleanupWorker) {
      cleanupWorker = new StorageCleanupWorker();
      cleanupWorker.start();
    }
  } catch (error) {
    console.error('Storage cleanup worker: Failed to initialize:', error);
  }
}

/**
 * Get the current media retention days setting
 */
export async function getMediaRetentionDays(): Promise<number> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
  
  // If environment variables aren't available, return default
  if (!supabaseUrl || !supabaseKey) {
    return 30; // Default to 30 days
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Query the system_config table directly instead of using RPC
  const { data, error } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'media_retention')
    .single();
  
  if (error || !data) {
    console.error('Error getting media retention days:', error);
    return 30; // Default to 30 days
  }
  
  return data.value?.days || 30;
}

/**
 * Set the media retention days setting
 */
export async function setMediaRetentionDays(days: number): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
  
  // Validate environment variables
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Cannot set media retention days: Missing required environment variables');
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Update the system_config table directly instead of using RPC
  const { error } = await supabase
    .from('system_config')
    .update({
      value: { days, enabled: true },
      updated_at: new Date().toISOString()
    })
    .eq('key', 'media_retention');
  
  if (error) {
    console.error('Error setting media retention days:', error);
    throw new Error('Failed to update media retention setting');
  }
}
