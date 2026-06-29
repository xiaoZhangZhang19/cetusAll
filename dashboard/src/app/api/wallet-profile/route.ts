import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * DELETE endpoint to remove wallet profile directory
 * This is needed when switching to a new domain, as MetaMask
 * connection authorization is domain-specific
 */
export async function DELETE(req: NextRequest) {
  try {
    const { project } = await req.json();
    
    if (!project || project !== 'peach') {
      return NextResponse.json(
        { error: 'Invalid project parameter' },
        { status: 400 }
      );
    }
    
    // Resolve wallet profile directory path
    const projectRoot = path.resolve(process.cwd(), '..', 'peach');
    const walletProfilePath = path.join(projectRoot, '.playwright-wallet-profile');
    
    console.log(`[wallet-profile] Attempting to delete: ${walletProfilePath}`);
    
    // Check if directory exists
    try {
      await fs.access(walletProfilePath);
    } catch {
      // Directory doesn't exist, that's okay
      console.log(`[wallet-profile] Directory not found (already clean): ${walletProfilePath}`);
      return NextResponse.json({
        success: true,
        message: 'Wallet profile directory not found (already clean)',
      });
    }
    
    // Delete the directory recursively
    await fs.rm(walletProfilePath, { recursive: true, force: true });
    console.log(`[wallet-profile] Successfully deleted: ${walletProfilePath}`);
    
    return NextResponse.json({
      success: true,
      message: 'Wallet profile directory deleted successfully',
      path: walletProfilePath,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[wallet-profile] Delete error:', message);
    return NextResponse.json(
      { error: `Failed to delete wallet profile: ${message}` },
      { status: 500 }
    );
  }
}
