/**
 * Copyright (C) 2010-2017 Alibaba Group Holding Limited
 */

/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var Q = require('q');
var fs = require('fs');
var path = require('path');
var shell = require('shelljs');
var events = require('cordova-common').events;
var xmlHelpers = require('cordova-common').xmlHelpers;
var CordovaError = require('cordova-common').CordovaError;
var ConfigParser = require('cordova-common').ConfigParser;
var FileUpdater = require('cordova-common').FileUpdater;
var PlatformJson = require('cordova-common').PlatformJson;
var PlatformMunger = require('cordova-common').ConfigChanges.PlatformMunger;
var PluginInfoProvider = require('cordova-common').PluginInfoProvider;

module.exports.prepare = function (cordovaProject, options) {
    var self = this;

    var platformJson = PlatformJson.load(this.locations.root, this.platform);
    var munger = new PlatformMunger(this.platform, this.locations.root, platformJson, new PluginInfoProvider());
    this._config = updateConfigFilesFrom(cordovaProject.projectConfig, munger, this.locations);

    // Update own www dir with project's www assets and plugins' assets and js-files
    return Q.when(updateWww(cordovaProject, this.locations))
    .then(function () {
        // update project according to config.xml changes.
        return updateProjectAccordingTo(self._config, self.locations);
    })
    .then(function () {
        updateIcons(cordovaProject, path.relative(cordovaProject.root,
            self.locations.res), self.locations.manifest);
        updateSplashes(cordovaProject, path.relative(cordovaProject.root,
            self.locations.res), self.locations.manifest);
        module.exports.updatePermissions.call(self);
    })
    .then(function () {
        events.emit('verbose', 'Prepared YunOS project successfully');
    });
};

module.exports.clean = function (options) {
    // A cordovaProject isn't passed into the clean() function, because it might have
    // been called from the platform shell script rather than the CLI. Check for the
    // noPrepare option passed in by the non-CLI clean script. If that's present, or if
    // there's no config.xml found at the project root, then don't clean prepared files.
    var projectRoot = path.resolve(this.root, '../..');
    if ((options && options.noPrepare) || !fs.existsSync(this.locations.configXml) ||
            !fs.existsSync(this.locations.configXml)) {
        return Q();
    }

    var projectConfig = new ConfigParser(this.locations.configXml);

    var self = this;
    return Q().then(function () {
        cleanWww(projectRoot, self.locations);
        cleanIcons(projectRoot, projectConfig, path.relative(projectRoot, self.locations.res));
        cleanSplashes(projectRoot, projectConfig, path.relative(projectRoot, self.locations.res));
    });
};


module.exports.updatePermissions = function() {
    var configParser = new ConfigParser(this.locations.configXml);
    var permissions = [];
    configParser.doc.findall('uses-permission').forEach(function(elt) {
        permissions.push(elt.attrib['yunos:name']);
    });
    var events = [];
    configParser.doc.findall('event').forEach(function(elt) {
        events.push(elt.attrib['yunos:name']);
    });

    var manifest = JSON.parse(fs.readFileSync(this.locations.manifest, 'utf-8'));
    if (manifest.domain.permission === undefined) {
        manifest.domain.permission = {};
    }
    if (manifest.domain.permission.use_permission === undefined) {
        manifest.domain.permission.use_permission = [];
    }
    for (var index in permissions) {
        var permission = permissions[index];
        if (!manifest.domain.permission.use_permission.includes(permission)) {
            manifest.domain.permission.use_permission.push(permission);
        }
    }

    if (events.length > 0) {
        manifest.pages.forEach(function(page) {
            if (page.main === true) {
                if (page.events === undefined) {
                    page.events = [];
                }
                events.forEach(function(event) {
                    // The same event won't add to manifest again.
                    if (page.events.filter(function(e) { return e.name === event; }).length === 0) {
                        page.events.push({"name": event});
                    }
                });
            }
        });
    }

    fs.writeFileSync(this.locations.manifest, JSON.stringify(manifest, null, 4), 'utf-8');
};


/**
 * Updates config files in project based on app's config.xml and config munge,
 *   generated by plugins.
 *
 * @param   {ConfigParser}   sourceConfig  A project's configuration that will
 *   be merged into platform's config.xml
 * @param   {ConfigChanges}  configMunger  An initialized ConfigChanges instance
 *   for this platform.
 * @param   {Object}         locations     A map of locations for this platform
 *
 * @return  {ConfigParser}                 An instance of ConfigParser, that
 *   represents current project's configuration. When returned, the
 *   configuration is already dumped to appropriate config.xml file.
 */
function updateConfigFilesFrom(sourceConfig, configMunger, locations) {
    events.emit('verbose', 'Generating platform-specific config.xml from defaults for YunOS at ' + locations.configXml);

    // First cleanup current config and merge project's one into own
    // Overwrite platform config.xml with defaults.xml.
    shell.cp('-f', locations.defaultConfigXml, locations.configXml);

    // Then apply config changes from global munge to all config files
    // in project (including project's config)
    configMunger.reapply_global_munge().save_all();

    events.emit('verbose', 'Merging project\'s config.xml into platform-specific YunOS config.xml');
    // Merge changes from app's config.xml into platform's one
    var config = new ConfigParser(locations.configXml);
    xmlHelpers.mergeXml(sourceConfig.doc.getroot(),
        config.doc.getroot(), 'yunos', /*clobber=*/true);

    config.write();
    return config;
}

/**
 * Logs all file operations via the verbose event stream, indented.
 */
function logFileOp(message) {
    events.emit('verbose', '  ' + message);
}

/**
 * Updates platform 'www' directory by replacing it with contents of
 *   'platform_www' and app www. Also copies project's overrides' folder into
 *   the platform 'www' folder
 *
 * @param   {Object}  cordovaProject    An object which describes cordova project.
 * @param   {Object}  destinations      An object that contains destination
 *   paths for www files.
 */
function updateWww(cordovaProject, destinations) {
    var sourceDirs = [
        path.relative(cordovaProject.root, cordovaProject.locations.www),
        path.relative(cordovaProject.root, destinations.platformWww)
    ];

    // If project contains 'merges' for our platform, use them as another overrides
    var merges_path = path.join(cordovaProject.root, 'merges', 'yunos');
    if (fs.existsSync(merges_path)) {
        events.emit('verbose', 'Found "merges/yunos" folder. Copying its contents into the yunos project.');
        sourceDirs.push(path.join('merges', 'yunos'));
    }

    var targetDir = path.relative(cordovaProject.root, destinations.www);
    events.emit(
        'verbose', 'Merging and updating files from [' + sourceDirs.join(', ') + '] to ' + targetDir);
    FileUpdater.mergeAndUpdateDir(
        sourceDirs, targetDir, { rootDir: cordovaProject.root }, logFileOp);
}

/**
 * Cleans all files from the platform 'www' directory.
 */
function cleanWww(projectRoot, locations) {
    var targetDir = path.relative(projectRoot, locations.www);
    events.emit('verbose', 'Cleaning ' + targetDir);

    // No source paths are specified, so mergeAndUpdateDir() will clear the target directory.
    FileUpdater.mergeAndUpdateDir(
        [], targetDir, { rootDir: projectRoot, all: true }, logFileOp);
}

/**
 * Updates orientation from project's configuration.
 *
 * @param   {String}  value  Orientation from config.xml
 * @param   {Object}  manifest  Json object of manifest.json
 */
function updateOrientation(value, manifest) {
    var orientationMap = {
        'all': 'auto',
        'default': 'default',
        'landscape': 'landscape_left',
        'portrait': 'portrait'
    };
    if (orientationMap[value] !== undefined) {
        manifest.pages[0].display.orientation = orientationMap[value];
    }
}

/**
 * Updates userAgent from project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration
 * @param   {Object}        manifest  Json object of manifest.json
 */
function updateUseragent(platformConfig, manifest) {
    var appendUserAgent = platformConfig.getPreference('AppendUserAgent');
    var overrideUserAgent = platformConfig.getPreference('OverrideUserAgent');

    if (appendUserAgent !== '' || overrideUserAgent !== '') {
        // ensure the existence of manifest.page.extension.web_app
        if (manifest.pages[0].extension === undefined) {
            manifest.pages[0].extension = {};
            manifest.pages[0].extension.web_app = {};
        } else if (manifest.pages[0].extension.web_app === undefined) {
            manifest.pages[0].extension.web_app = {};
        }
        // write the appendUserAgent preference
        if (appendUserAgent !== '') {
            manifest.pages[0].extension.web_app.append_user_agent = appendUserAgent;
        } else {
            manifest.pages[0].extension.web_app.append_user_agent = undefined;
        }
        // write the overrideUserAgent preference
        if (overrideUserAgent !== '') {
            manifest.pages[0].extension.web_app.override_user_agent = overrideUserAgent;
        } else {
            manifest.pages[0].extension.web_app.override_user_agent = undefined;
        }
    } else if (manifest.pages[0].extension !== undefined &&
               manifest.pages[0].extension.web_app !== undefined) {
        // update the userAgent preference if it remove from config.xml
        manifest.pages[0].extension.web_app.append_user_agent = undefined;
        manifest.pages[0].extension.web_app.override_user_agent = undefined;
    }
}

/**
 * Updates project structure and manifest.json according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectAccordingTo(platformConfig, locations) {
    // Packages cannot support dashes
    var pkg = platformConfig.packageName().replace(/-/g, '_');

    // Update manifest.json
    var manifest = JSON.parse(fs.readFileSync(locations.manifest, 'utf-8'));
    // domain name
    manifest.domain.name = platformConfig.packageName();
    // page uri
    manifest.pages[0].uri = 'page://' + platformConfig.packageName() + '/' + platformConfig.name();

    // versions
    var version = platformConfig.version();
    var versionCode = default_versionCode(version);
    manifest.domain.version = version;
    manifest.domain.version_code = versionCode;
    if (manifest.pages[0].display === undefined) {
        manifest.pages[0].display = {};
    }
    // orientation
    var orientation = platformConfig.getPreference('orientation');
    updateOrientation(orientation, manifest);
    // fullscreen
    var fullscreen = (platformConfig.getPreference('fullscreen') == 'true');
    manifest.pages[0].display.fullscreen = fullscreen;
    // useragent
    updateUseragent(platformConfig, manifest);

    fs.writeFileSync(locations.manifest, JSON.stringify(manifest, null, 4), 'utf-8');
    events.emit('verbose', 'Wrote out YunOS manifest.');
}

// Consturct the default value for versionCode as
// PATCH + MINOR * 100 + MAJOR * 10000
// see http://developer.android.com/tools/publishing/versioning.html
function default_versionCode(version) {
    var nums = version.split('-')[0].split('.');
    var versionCode = 0;
    if (+nums[0]) {
        versionCode += +nums[0] * 10000;
    }
    if (+nums[1]) {
        versionCode += +nums[1] * 100;
    }
    if (+nums[2]) {
        versionCode += +nums[2];
    }

    events.emit('verbose', 'YunOS versionCode not found in config.xml. Generating a code based on version in config.xml (' + version + '): ' + versionCode);
    return versionCode;
}

function updateSplashes(cordovaProject, platformResourcesDir, manifestPath) {
    var splashes = cordovaProject.projectConfig.getSplashScreens('yunos');
    if (splashes.length === 0) {
        return;
    }

    var defaultSplash;
    var yunosSplashes = {};
    splashes.forEach(function(splash) {
        if (!splash.density) {
            if (!defaultSplash) {
                defaultSplash = splash.src;
            } else {
                events.emit('verbose', 'Found extra default splash: ' + splash.src +
                    ' (ignoring in favor of ' + defaultSplash + ')');
            }
        } else {
            yunosSplashes[splash.density] = splash.src;
        }
    });

    // Copy it to yunos package
    // TODO: should delete another duplicate item if splash image is under www
    var resourceMap = {};
    var fileName;
    var targetPath;
    for (var density in yunosSplashes) {
        fileName = 'splashScreen.' + yunosSplashes[density].split('.').pop();
        targetPath = path.join(platformResourcesDir, density, fileName);
        resourceMap[targetPath] = yunosSplashes[density];
    }
    if (defaultSplash) {
        fileName = 'splashScreen.' + defaultSplash.split('.').pop();
        targetPath = path.join(platformResourcesDir, 'default', fileName);
        resourceMap[targetPath] = defaultSplash;
    }
    events.emit('verbose', 'Updating splashes at ' + platformResourcesDir);
    FileUpdater.updatePaths(resourceMap, {rootDir: cordovaProject.root}, logFileOp);

    // Update manifest.json
    var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.pages[0].splash = fileName;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4), 'utf-8');
    events.emit('verbose', 'Updating manifest.json for splash.');
}

function cleanSplashes(projectRoot, projectConfig, platformResourcesDir) {
}

function updateIcons(cordovaProject, platformResourcesDir, manifestDir) {
    var icons = cordovaProject.projectConfig.getIcons('yunos');
    // if there are no icon elements in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    var yunosIcons = {};
    var defaultIcon;
    // http://developer.android.com/design/style/iconography.html
    var sizeToDensityMap = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };
    // find the best matching icon for a given density or size
    // @output yunosIcons
    var parseIcon = function(icon, iconSize) {
        // do I have a platform icon for that density already
        var density = icon.density || sizeToDensityMap[iconSize];
        if (!density) {
            events.emit('verbose', 'invalid icon defition ( or unsupported size)');
            return;
        }
        var previous = yunosIcons[density];
        if (previous && previous.platform) {
            return;
        }
        yunosIcons[density] = icon.src;
    };

    // iterate over all icon elements to find the default icon and call parseIcon
    // TODO: Support different devices
    icons.forEach(function(icon) {
        var size = icon.width;
        if (!size) {
            size = icon.height;
        }
        if (!size && !icon.density) {
            if (defaultIcon) {
                events.emit('verbose', 'Found extra default icon: ' + icon.src + ' (ignoring in favor of ' + defaultIcon.src + ')');
            } else {
                defaultIcon = icon.src;
            }
        } else {
            parseIcon(icon, size);
        }
    });

    // The source paths for icons and splashes are relative to
    // project's config.xml location, so we use it as base path.
    var resourceMap = {};
    var fileName;
    for (var density in yunosIcons) {
        fileName = 'icon.' + yunosIcons[density].split('.').pop();
        var targetPath = path.join(platformResourcesDir, density, fileName);
        resourceMap[targetPath] = yunosIcons[density];
    }
    if (defaultIcon) {
        fileName = 'icon.' + defaultIcon.split('.').pop();
        var defaultTargetPath = path.join(platformResourcesDir, 'default', fileName);
        resourceMap[defaultTargetPath] = defaultIcon;
    }
    events.emit('verbose', 'Updating icons at ' + platformResourcesDir);
    FileUpdater.updatePaths(resourceMap, { rootDir: cordovaProject.root }, logFileOp);

    // Update manifest.json
    var manifest = JSON.parse(fs.readFileSync(manifestDir, 'utf-8'));
    manifest.pages[0].icon = path.join(fileName);
    fs.writeFileSync(manifestDir, JSON.stringify(manifest, null, 4), 'utf-8');
    events.emit('verbose', 'Updating manifest.json for icon.');
}

function cleanIcons(projectRoot, projectConfig, platformResourcesDir) {
}
