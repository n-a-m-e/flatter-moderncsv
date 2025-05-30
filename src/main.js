// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2022 Andy Holmes <andrew.g.r.holmes@gmail.com>

import * as artifact from '@actions/artifact';
import * as core from '@actions/core';

import * as fs from 'fs';
import * as path from 'path';

import * as flatter from './flatter.js';
import * as utils from './utils.js';


async function includeFiles(repo) {
    const files = core.getMultilineInput('upload-pages-includes');
    const operations = files.map(src => {
        const dest = path.join(repo, path.basename(src));
        return fs.promises.copyFile(src, dest);
    });

    return Promise.allSettled(operations);
}

/**
 * Run the action
 */
async function run() {
    const manifests = core.getMultilineInput('files');
    const repository = `${process.cwd()}/repo`;
    core.setOutput('repository', repository);


    /*
     * Build the Flatpak manifests
     */
    if (core.getBooleanInput('run-tests')) {
        for (const manifest of manifests) {
            core.info(`Testing "${manifest}"`);

            try {
                await flatter.checkApplication(repository, manifest);
            } catch (e) {
                core.warning(`Checking "${manifest}": ${e.message}`);
            }

            try {
                await flatter.testApplication(repository, manifest);
            } catch (e) {
                core.setFailed(`Testing "${manifest}": ${e.message}`);
            }

            if (process.exitCode === core.ExitCode.Failure)
                return;
        }
    } else {
        await flatter.restoreCache(repository);

        for (const manifest of manifests) {
            core.info(`Building "${manifest}"`);

            try {
                await flatter.buildApplication(repository, manifest);
            } catch (e) {
                core.setFailed(`Building "${manifest}": ${e.message}`);
            }

            if (process.exitCode === core.ExitCode.Failure)
                return;
        }

        await flatter.saveCache(repository);
    }

    /*
     * GitHub Pages Artifact
     */
    if (core.getBooleanInput('upload-pages-artifact')) {
        core.startGroup('Uploading GitHub Pages artifact...');

        try {
            // Generate a .flatpakrepo file
            await flatter.generateDescription(repository);

            // Copy extra files to the repository directory
            await includeFiles(repository);

            // Upload the repository directory as a Github Pages artifact
            await utils.uploadPagesArtifact(repository);
        } catch (e) {
            core.setFailed(`Failed to upload artifact: ${e.message}`);
        }

        core.endGroup();

        if (process.exitCode === core.ExitCode.Failure)
            return;
    }

    /*
     * Flatpak Bundles
     */
    if (core.getBooleanInput('upload-bundles')) {
        core.startGroup('Uploading Flatpak bundles...');

        const artifactClient = new artifact.DefaultArtifactClient();

        for (const manifest of manifests) {
            try {
                const filePath = await flatter.bundleApplication(repository,
                    manifest);
                const artifactName = filePath.replace('.flatpak',
                    `-${core.getInput('arch')}`);

                await artifactClient.uploadArtifact(artifactName, [filePath], '.');
            } catch (e) {
                core.setFailed(`Failed to bundle "${manifest}": ${e.message}`);
            }
        }

        core.endGroup();
    }
}

run();

export default run;

