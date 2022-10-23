// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2022 Andy Holmes <andrew.g.r.holmes@gmail.com>

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as yaml from 'js-yaml';

import * as utils from './utils.js';


export {
    buildApplication,
    bundleApplication,
    generateDescription,
    restoreCache,
    saveCache,
};


function checksumFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', error => reject(error));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Load a manifest
 *
 * @param {PathLike} manifestPath - A path to a Flatpak manifest
 */
async function parseManifest(manifestPath) {
    const data = await fs.promises.readFile(manifestPath);

    switch (path.extname(manifestPath)) {
        case '.json':
            return JSON.parse(data);

        case '.yaml':
        case '.yml':
            return yaml.load(data);

        default:
            throw TypeError('Unsupported manifest format');
    }
}

/**
 * Generate a .flatpakrepo file and copy it to the repository directory.
 *
 * @param {PathLike} directory - A path to a Flatpak repository
 * @returns {Promise<>} A promise for the operation
 */
async function generateDescription(directory) {
    /* Collect the .flatpakrepo fields */
    const {repository} = github.context.payload;

    const metadata = {
        Title: repository.name,
        Description: repository.description,
        Url: `https://${repository.owner.login}.github.io/${repository.name}`,
        Homepage: repository.homepage || repository.html_url,
        Icon: 'https://raw.githubusercontent.com/flatpak/flatpak/main/flatpak.png',
    };

    /* Append the GPG Public Key */
    if (core.getInput('gpg-sign')) {
        const {stdout} = await exec.getExecOutput('gpg2',
            ['--armor', '--export', core.getInput('gpg-sign')]);
        const publicKey = stdout.split('\n').slice(2, -2).join('');
        metadata['GPGKey'] = publicKey;
    }

    let flatpakrepo = '[Flatpak Repo]';

    for (const [key, value] of Object.entries(metadata))
        flatpakrepo = `${flatpakrepo}\n${key}=${value}`;

    await fs.promises.writeFile(`${directory}/index.flatpakrepo`, flatpakrepo);
}


/**
 * Build a Flatpak for the repository.
 *
 * A single repository cache is kept for all builds, while each architecture has
 * its own cache. This keeps the benefits of caching, while being able to serve
 * multiple architectures from the same repository.
 *
 * @param {PathLike} directory - A path to a Flatpak repository
 * @param {PathLike} manifest - A path to a Flatpak manifest
 */
async function buildApplication(directory, manifest) {
    const arch = core.getInput('arch');
    const checksum = await checksumFile(manifest);
    const stateDir = `.flatpak-builder-${arch}-${checksum}`;

    let cacheId, cacheKey;
    if ((cacheKey = core.getInput('cache-key')) && cache.isFeatureAvailable()) {
        cacheKey = `${cacheKey}-${arch}-${checksum}`;
        cacheId = await cache.restoreCache([stateDir], cacheKey);

        if (cacheId)
            core.info(`Cache "${cacheId}" restored with key "${cacheKey}"`);
    }

    const builderArgs = [
        `--arch=${core.getInput('arch')}`,
        '--ccache',
        '--disable-rofiles-fuse',
        '--force-clean',
        `--repo=${directory}`,
        `--state-dir=${stateDir}`,
        ...(utils.getStrvInput('flatpak-builder-args')),
    ];

    if (core.getInput('gpg-sign'))
        builderArgs.push(`--gpg-sign=${core.getInput('gpg-sign')}`);

    await exec.exec('flatpak-builder', [
        ...builderArgs,
        '_build',
        manifest,
    ]);

    if (!cacheId?.localeCompare(cacheKey, undefined, { sensitivity: 'accent' }))
        await cache.saveCache([stateDir], cacheKey);
}

/**
 * Create a single-file bundle from a local repository.
 *
 * This function is a convenience for extracting the application ID and default
 * branch from @manifest, before calling `buildBundle)()`.
 *
 * @param {PathLike} directory - A path to a Flatpak repository
 * @param {PathLike} manifest - A path to a Flatpak manifest
 * @returns {Promise<>} A promise for the operation
 */
async function bundleApplication(directory, manifest) {
    const metadata = await parseManifest(manifest);
    const appId = metadata['app-id'] || metadata['id'];
    const branch = metadata['branch'] || metadata['default-branch'] || 'master';
    const fileName = `${appId}.flatpak`;

    const bundleArgs = [
        `--arch=${core.getInput('arch')}`,
        ...(utils.getStrvInput('flatpak-build-bundle-args')),
    ];

    if (core.getInput('gpg-sign'))
        bundleArgs.push(`--gpg-sign=${core.getInput('gpg-sign')}`);

    await exec.exec('flatpak', [
        'build-bundle',
        ...bundleArgs,
        directory,
        fileName,
        appId,
        branch,
    ]);

    return fileName;
}

/**
 * Restore the Flatpak repository from cache.
 *
 * The repository is restored from the most recently saved cache with the same
 * `cache-key` and GPG signature (if available).
 *
 * @param {PathLike} directory - A path to a Flatpak repository
 * @returns {Promise<>} A promise for the operation
 */
async function restoreCache(directory) {
    core.startGroup('Restoring repository from cache...');

    try {
        // Check if caching is enabled and supported
        const baseKey = core.getInput('cache-key');
        if (!baseKey || !cache.isFeatureAvailable()) {
            core.info('Cache disabled');
            return;
        }

        // Restore the repository from cache
        const cachePaths = [directory];
        const cacheKey = core.getInput('gpg-sign')
            ? `${baseKey}-${core.getInput('gpg-sign')}-${Date.now()}`
            : `${baseKey}-${Date.now()}`;
        const restoreKeys = [
            core.getInput('gpg-sign')
                ? `${baseKey}-${core.getInput('gpg-sign')}-`
                : `${baseKey}-`,
        ];
        const cacheId = await cache.restoreCache(cachePaths, cacheKey,
            restoreKeys);

        if (cacheId)
            core.info(`Cache "${cacheId}" restored with key "${cacheKey}"`);
    } catch (e) {
        core.warning(`Failed to restore repository from cache: ${e.message}`);
    }

    core.endGroup();
}

/**
 * Save the Flatpak repository to cache.
 *
 * The repository is saved by appending the GPG signature (if available) and a
 * timestamp to the `cache-key`. Since the repository is restored with just the
 * GPG signature appended to the `cache-key`, a cache hit never occurs and the
 * most recently used cache is restored. The result is an incrementally updated
 * repository, built on immutable caches.
 *
 * @param {PathLike} directory - A path to a Flatpak repository
 * @returns {Promise<>} A promise for the operation
 */
async function saveCache(directory) {
    core.startGroup('Saving repository to cache...');

    try {
        // Check if caching is enabled and supported
        const baseKey = core.getInput('cache-key');
        if (!baseKey || !cache.isFeatureAvailable()) {
            core.info('Cache disabled');
            return;
        }

        // Save the repository to cache
        const cachePaths = [directory];
        const cacheKey = core.getInput('gpg-sign')
            ? `${baseKey}-${core.getInput('gpg-sign')}-${Date.now()}`
            : `${baseKey}-${Date.now()}`;
        const cacheId = await cache.saveCache(cachePaths, cacheKey);

        if (cacheId != -1)
            core.info(`Cache "${cacheId}" saved with key "${cacheKey}"`);
    } catch (e) {
        core.warning(`Failed to save repository to cache: ${e.message}`);
    }

    core.endGroup();
}
