/**
 * GitHub OAuth for GentDex profile claiming
 * 
 * Flow:
 * 1. User clicks "Claim with GitHub" → redirect to GitHub OAuth
 * 2. GitHub redirects back with code
 * 3. We exchange code for access token
 * 4. We fetch user's repos and verify ownership
 * 5. If verified, allow claim
 */

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'https://gentdex.com/api/auth/github/callback';

/**
 * Generate GitHub OAuth URL
 */
export function getGitHubAuthUrl(agentId, walletAddress) {
  const state = Buffer.from(JSON.stringify({ agentId, walletAddress })).toString('base64');
  
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: 'read:user repo',
    state,
  });
  
  return `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * Exchange code for access token
 */
export async function exchangeCodeForToken(code) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  
  const data = await response.json();
  
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  
  return data.access_token;
}

/**
 * Get authenticated user info
 */
export async function getGitHubUser(accessToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }
  
  return response.json();
}

/**
 * Get user's repos
 */
export async function getUserRepos(accessToken) {
  const repos = [];
  let page = 1;
  
  while (page <= 5) { // Max 5 pages (500 repos)
    const response = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&type=owner`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }
    );
    
    if (!response.ok) break;
    
    const data = await response.json();
    if (data.length === 0) break;
    
    repos.push(...data);
    page++;
  }
  
  return repos;
}

/**
 * Check if user owns a specific repo
 */
export async function verifyRepoOwnership(accessToken, repoFullName) {
  // repoFullName is "owner/repo" format
  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );
  
  if (!response.ok) {
    return { verified: false, reason: 'Repo not found or not accessible' };
  }
  
  const repo = await response.json();
  const user = await getGitHubUser(accessToken);
  
  // Check if user is owner or has admin access
  const isOwner = repo.owner.login.toLowerCase() === user.login.toLowerCase();
  const isAdmin = repo.permissions?.admin === true;
  
  if (isOwner || isAdmin) {
    return { 
      verified: true, 
      githubUsername: user.login,
      repoOwner: repo.owner.login,
    };
  }
  
  return { 
    verified: false, 
    reason: `You don't have admin access to ${repoFullName}`,
    yourUsername: user.login,
    repoOwner: repo.owner.login,
  };
}

/**
 * Extract repo full name from GitHub URL
 */
export function extractRepoFromUrl(githubUrl) {
  if (!githubUrl) return null;
  
  // Handle various GitHub URL formats
  const patterns = [
    /github\.com\/([^\/]+\/[^\/]+)/,
    /github\.com\/([^\/]+\/[^\/]+)\.git/,
  ];
  
  for (const pattern of patterns) {
    const match = githubUrl.match(pattern);
    if (match) {
      return match[1].replace(/\.git$/, '');
    }
  }
  
  return null;
}

export const isConfigured = () => !!GITHUB_CLIENT_ID && !!GITHUB_CLIENT_SECRET;
