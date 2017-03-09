/*
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
*/
let configHelper = require('./ConfigHelper');
let pluginManager = require('./PluginManager').getInstance();

module.exports = {
    init: function() {
        function error(err) {
            console.log('Read config.xml error: ' + err);
        }
        function success(config) {
            console.log('Read config.xml succeed, start parsing:');
            let features = config.features;
            for (i in features) {
                let feature = features[i];
                let service = feature.name;
                let path = '';
                let run = false;
                for (j in feature.params) {
                    let param = feature.params[j];
                    let paramName = param.name;
                    if (paramName === 'yunos-package') {
                        path = param.value;
                    } else if (paramName === 'onload') {
                        run = param.value === 'true'? true : false;
                    }
                }
                pluginManager.addService(service, path, run);
            }
        }
        configHelper.readConfig(success, error);
    }
};