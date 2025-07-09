/*globals define*/
/*
 * Этот файл содержит логику для преобразования модели конечного автомата WebGME
 * в конфигурацию YAML для Home Assistant.
 * Он разработан как прямая замена для генератора C++.
 */
define([
    // ЗАВИСИМОСТЬ: Убедитесь, что библиотека js-yaml доступна в вашем проекте (например, через bower).
    'bower/js-yaml/dist/js-yaml.min', 
], function (
    jsyaml
) {
    'use strict';

    /**
     * Вспомогательная функция для преобразования строк в snake_case,
     * принятый в Home Assistant (например, "My State" -> "my_state").
     * @param {string} str - Входная строка.
     * @returns {string}
     */
    var toSnakeCase = function (str) {
        if (!str) return '';
        return str.replace(/[\s\W]+/g, '_')
                  .replace(/([A-Z])/g, '_$1')
                  .replace(/__+/g, '_')
                  .replace(/^_|_$/g, '')
                  .toLowerCase();
    };
    
    /**
     * Безопасно парсит строку YAML. Возвращает массив действий или null в случае ошибки.
     * @param {string} yamlString - Строка с YAML-контентом.
     * @param {object} logger - Логгер WebGME для вывода предупреждений.
     * @returns {Array|null}
     */
    var safeLoadYamlAction = function(yamlString, logger) {
        if (!yamlString || typeof yamlString !== 'string' || yamlString.trim() === '') {
            return null;
        }
        try {
            const parsed = jsyaml.load(yamlString);
            if (Array.isArray(parsed)) return parsed; // Если это уже массив, возвращаем его
            if (typeof parsed === 'object' && parsed !== null) return [parsed]; // Оборачиваем одиночный объект в массив
            
            (logger || console).warn(`Содержимое YAML было разобрано, но не является объектом или массивом: ${yamlString}`);
            return null;
        } catch (e) {
            (logger || console).warn(`Не удалось разобрать строку YAML. Ошибка: ${e.message}. Содержимое: "${yamlString}"`);
            return null;
        }
    };

    return {
        /**
         * Основная функция, генерирующая YAML для Home Assistant.
         * Имя 'renderHFSM' сохранено для совместимости с SoftwareGenerator.js.
         * Эта функция полностью заменяет логику генерации C++.
         *
         * @param {object} model - Модель проекта WebGME, как она поступает из SoftwareGenerator.js.
         * @param {string} namespace - (Не используется, но оставлен для совместимости).
         * @param {function} objToFilePrefixFn - Функция для добавления префикса к имени файла.
         * @returns {object} - Словарь с артефактами в виде { 'filename.yaml': 'file_content' }.
         */
        renderHFSM: function (model, namespace, objToFilePrefixFn) {
            // 'this' будет содержать logger, если он передан из SoftwareGenerator
            var logger = this.logger || console;
            var objects = model.objects;
            var generatedArtifacts = {};

            var smRoot = Object.values(objects).find(o => o.type === 'State Machine');
            if (!smRoot) {
                logger.warn('Не найдена "State Machine" в модели. Генерация YAML невозможна.');
                return {};
            }

            // --- Сбор и структурирование данных из модели ---
            var states = [];
            var transitions = [];
            var initialStateName = null;

            Object.keys(objects).forEach(path => {
                var obj = objects[path];
                obj.id = path; // Сохраняем путь как уникальный ID для связей

                if (obj.type === 'State' || obj.type === 'End State') {
                    states.push(obj);
                } else if (obj.type === 'Transition') {
                    transitions.push(obj);
                } else if (obj.type === 'Initial') {
                    var initialTransition = Object.values(objects).find(t => t.type === 'Transition' && t.src === obj.id);
                    if (initialTransition && objects[initialTransition.dst]) {
                        initialStateName = toSnakeCase(objects[initialTransition.dst].sanitizedName);
                    }
                }
            });

            if (!initialStateName && states.length > 0) {
                initialStateName = toSnakeCase(states[0].sanitizedName);
                logger.warn(`Начальное состояние не определено явно. Установлено первое найденное: "${initialStateName}"`);
            }
            
            // --- Формирование JS-объекта для последующей конвертации в YAML ---
            var smSnakeName = toSnakeCase(smRoot.sanitizedName);
            var inputSelectEntityId = `input_select.${smSnakeName}`;
            var eventType = `${smSnakeName}_event`;

            var haConfig = {};

            // 1. input_select для хранения состояния
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = {
                name: smRoot.sanitizedName,
                options: states.map(s => toSnakeCase(s.sanitizedName)),
                initial: initialStateName,
                icon: 'mdi:state-machine',
            };

            // 2. automation для управления переходами
            haConfig.automation = [{
                id: `${smSnakeName}_automation`,
                alias: `State Machine: ${smRoot.sanitizedName}`,
                description: `Handles state transitions for ${smRoot.sanitizedName}`,
                mode: 'single',
                trigger: [{
                    platform: 'event',
                    event_type: eventType,
                }],
                action: [{
                    choose: transitions.map(trans => {
                        var sourceState = objects[trans.src];
                        var targetState = objects[trans.dst];
                        // Используем sanitizedName перехода как имя события
                        var eventName = trans.sanitizedName;

                        if (!sourceState || !targetState || sourceState.type === 'Initial' || !eventName) {
                            return null; // Пропускаем некорректные переходы
                        }

                        // Собираем последовательность действий: exit -> transition -> entry
                        var sequence = [];
                        
                        // Exit Action (из исходного состояния)
                        const exitActions = safeLoadYamlAction(sourceState.attributes.exitAction, logger);
                        if (exitActions) sequence.push(...exitActions);
                        
                        // Transition Action (самого перехода)
                        const transitionActions = safeLoadYamlAction(trans.attributes.action, logger);
                        if (transitionActions) sequence.push(...transitionActions);

                        // Главное действие: смена состояния
                        sequence.push({
                            service: 'input_select.select_option',
                            target: { entity_id: inputSelectEntityId },
                            data: { option: toSnakeCase(targetState.sanitizedName) },
                        });
                        
                        // Entry Action (в целевое состояние)
                        const entryActions = safeLoadYamlAction(targetState.attributes.entryAction, logger);
                        if (entryActions) sequence.push(...entryActions);

                        // Формируем блок 'choose' для автоматизации
                        var choice = {
                            conditions: [
                                { condition: 'state', entity_id: inputSelectEntityId, state: toSnakeCase(sourceState.sanitizedName) },
                                { condition: 'template', value_template: `{{ trigger.event.data.event == '${eventName}' }}` }
                            ],
                            sequence: sequence
                        };

                        // Добавляем 'guard' (условие) перехода, если он есть в атрибутах
                        if (trans.attributes.guard) {
                            choice.conditions.push({
                                condition: 'template',
                                value_template: `{{ ${trans.attributes.guard} }}`
                            });
                        }

                        return choice;
                    }).filter(c => c !== null) // Убираем null-значения от пропущенных переходов
                }]
            }];

            // --- Конвертация JS-объекта в YAML строку ---
            var yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });

            var fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n#\n`+
                             `# To trigger a transition, fire an event like this:\n` +
                             `# service: event.fire\n` +
                             `# data:\n` +
                             `#   event_type: ${eventType}\n` +
                             `#   event_data:\n` +
                             `#     event: "YOUR_EVENT_NAME" (e.g., "${transitions.length > 0 ? transitions[0].sanitizedName : 'some_event'}")\n#\n\n`;
            
            yamlString = fileHeader + yamlString;

            // --- Формирование артефакта ---
            var fileName = `${smSnakeName}.yaml`;
            if (objToFilePrefixFn) {
                var prefix = objToFilePrefixFn(smRoot);
                if (prefix) {
                    fileName = prefix + fileName;
                }
            }

            generatedArtifacts[fileName] = yamlString;
            return generatedArtifacts;
        },

        /**
         * Эта функция больше не нужна для генерации YAML, но оставлена пустой
         * для совместимости с SoftwareGenerator.js, если он попытается ее вызвать.
         * @returns {object} - Пустой объект.
         */
        renderTestCode: function (model, namespace, objToFilePrefixFn) {
            (this.logger || console).info('Test code generation is not applicable for Home Assistant YAML target and will be skipped.');
            return {};
        }
    };
});