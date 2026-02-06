/**
 * GentDex Fly.io Machine Provisioner
 * 
 * Spins up OpenSolBot Docker containers on Fly.io Machines API.
 * Each deploy session gets its own isolated VM with:
 * - OpenSolBot (copy trading / trading / wallet tracker)
 * - MySQL + Redis (sidecar or shared)
 * - Telegram bot interface
 * - Auto-shutdown on expiry
 *
 * Fly Machines API docs: https://fly.io/docs/machines/api/
 */

const FLY_API = 'https://api.machines.dev/v1';

class FlyProvisioner {
  constructor(apiToken, orgSlug = 'personal') {
    this.apiToken = apiToken;
    this.orgSlug = orgSlug;
    this.appPrefix = 'gentdex-agent';
  }

  headers() {
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create a Fly app for a deploy session
   */
  async createApp(sessionId) {
    const appName = `${this.appPrefix}-${sessionId.slice(0, 8)}`;
    
    const res = await fetch(`${FLY_API}/apps`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        app_name: appName,
        org_slug: this.orgSlug,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      // App might already exist
      if (res.status === 422 && err.includes('already exists')) {
        return appName;
      }
      throw new Error(`Failed to create app: ${res.status} ${err}`);
    }

    return appName;
  }

  /**
   * Provision a full OpenSolBot stack for a session
   * Returns machine IDs and connection details
   */
  async provision(session) {
    const {
      sessionId,
      targetWallet,
      durationDays,
      botKeypair,       // Base58 private key for the session bot
      tgBotToken,       // Telegram bot token
      heliusApiKey,     // Optional
      rpcEndpoint,      // Solana RPC
    } = session;

    const appName = await this.createApp(sessionId);
    const region = 'iad'; // US East (closest to Solana validators)

    // 1. Create Redis machine
    const redis = await this.createMachine(appName, {
      name: `redis-${sessionId.slice(0, 8)}`,
      region,
      config: {
        image: 'redis:7.2-alpine',
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
        services: [{
          protocol: 'tcp',
          internal_port: 6379,
          // No public port — internal only
        }],
        auto_destroy: true,
        restart: { policy: 'on-failure', max_retries: 3 },
      },
    });

    // 2. Create MySQL machine
    const mysql = await this.createMachine(appName, {
      name: `mysql-${sessionId.slice(0, 8)}`,
      region,
      config: {
        image: 'mysql:8.0',
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        env: {
          MYSQL_ROOT_PASSWORD: 'root',
          MYSQL_DATABASE: 'solana_trade_bot',
        },
        services: [{
          protocol: 'tcp',
          internal_port: 3306,
        }],
        mounts: [{
          volume: await this.createVolume(appName, `mysql-${sessionId.slice(0, 8)}`, region),
          path: '/var/lib/mysql',
        }],
        auto_destroy: true,
        restart: { policy: 'on-failure', max_retries: 3 },
      },
    });

    // Wait for MySQL to be ready
    await this.waitForMachine(appName, mysql.id, 30000);

    // 3. Create OpenSolBot machine (all-in-one: tracker + trading + tg-bot)
    const botConfig = this.buildBotConfig({
      sessionId,
      targetWallet,
      botKeypair,
      tgBotToken,
      heliusApiKey,
      rpcEndpoint,
      mysqlHost: `${mysql.id}.vm.${appName}.internal`,
      redisHost: `${redis.id}.vm.${appName}.internal`,
      region,
    });

    const bot = await this.createMachine(appName, botConfig);

    // 4. Schedule auto-destroy after duration + 1 hour grace
    const ttlSeconds = (durationDays * 86400) + 3600;
    await this.setMachineLease(appName, bot.id, ttlSeconds);

    return {
      appName,
      machines: {
        redis: redis.id,
        mysql: mysql.id,
        bot: bot.id,
      },
      region,
      status: 'provisioned',
      expiresAt: new Date(Date.now() + durationDays * 86400000).toISOString(),
    };
  }

  /**
   * Build the OpenSolBot machine config
   */
  buildBotConfig({ sessionId, targetWallet, botKeypair, tgBotToken, heliusApiKey, rpcEndpoint, mysqlHost, redisHost, region }) {
    return {
      name: `bot-${sessionId.slice(0, 8)}`,
      region,
      config: {
        // Use our custom OpenSolBot image (to be pushed to Fly registry)
        image: 'registry.fly.io/gentdex-opensolbot:latest',
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        env: {
          // Database
          DB__MYSQL_URL: `mysql+pymysql://root:root@${mysqlHost}:3306/solana_trade_bot`,
          DB__REDIS_URL: `redis://${redisHost}:6379/0`,
          
          // Solana
          SOLANA_RPC: rpcEndpoint || 'https://api.mainnet-beta.solana.com',
          BOT_KEYPAIR: botKeypair,
          
          // Copy trading target
          COPY_TARGET_WALLET: targetWallet,
          
          // Telegram
          TG_BOT_TOKEN: tgBotToken,
          
          // APIs
          HELIUS_API_KEY: heliusApiKey || '',
          
          // GentDex session
          GENTDEX_SESSION_ID: sessionId,
          GENTDEX_ESCROW_PROGRAM: '9hyscAyfR2puBXWFoGzeBq3QtSn5e83B7AUkcS1qC5RJ',
        },
        services: [],
        auto_destroy: true,
        restart: { policy: 'on-failure', max_retries: 5 },
        checks: {
          health: {
            type: 'http',
            port: 8080,
            path: '/health',
            interval: '30s',
            timeout: '5s',
          },
        },
      },
    };
  }

  /**
   * Create a Fly Machine
   */
  async createMachine(appName, machineConfig) {
    const res = await fetch(`${FLY_API}/apps/${appName}/machines`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(machineConfig),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create machine: ${res.status} ${err}`);
    }

    return res.json();
  }

  /**
   * Create a volume for persistent storage
   */
  async createVolume(appName, name, region) {
    const res = await fetch(`${FLY_API}/apps/${appName}/volumes`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        name,
        region,
        size_gb: 1,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create volume: ${res.status} ${err}`);
    }

    const vol = await res.json();
    return vol.id;
  }

  /**
   * Wait for a machine to be in started state
   */
  async waitForMachine(appName, machineId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`${FLY_API}/apps/${appName}/machines/${machineId}`, {
        headers: this.headers(),
      });
      
      if (res.ok) {
        const machine = await res.json();
        if (machine.state === 'started') return machine;
      }
      
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Machine ${machineId} did not start within ${timeoutMs}ms`);
  }

  /**
   * Set a lease/TTL on a machine for auto-shutdown
   */
  async setMachineLease(appName, machineId, ttlSeconds) {
    // Fly doesn't have native TTL, so we'll use metadata
    // and a cron job to clean up expired machines
    const res = await fetch(`${FLY_API}/apps/${appName}/machines/${machineId}/metadata/gentdex_expires_at`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        value: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }),
    });
    return res.ok;
  }

  /**
   * Stop and destroy all machines in a session
   */
  async teardown(appName) {
    // List all machines
    const res = await fetch(`${FLY_API}/apps/${appName}/machines`, {
      headers: this.headers(),
    });

    if (!res.ok) return;

    const machines = await res.json();
    
    // Stop then destroy each
    for (const machine of machines) {
      try {
        await fetch(`${FLY_API}/apps/${appName}/machines/${machine.id}/stop`, {
          method: 'POST',
          headers: this.headers(),
        });
        
        await new Promise(r => setTimeout(r, 1000));
        
        await fetch(`${FLY_API}/apps/${appName}/machines/${machine.id}`, {
          method: 'DELETE',
          headers: this.headers(),
          body: JSON.stringify({ force: true }),
        });
      } catch (e) {
        console.error(`Failed to destroy machine ${machine.id}:`, e.message);
      }
    }

    // Delete the app
    await fetch(`${FLY_API}/apps/${appName}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  /**
   * Get status of all machines in a session
   */
  async getStatus(appName) {
    const res = await fetch(`${FLY_API}/apps/${appName}/machines`, {
      headers: this.headers(),
    });

    if (!res.ok) return null;

    const machines = await res.json();
    return machines.map(m => ({
      id: m.id,
      name: m.name,
      state: m.state,
      region: m.region,
      created: m.created_at,
    }));
  }
}

export { FlyProvisioner };
