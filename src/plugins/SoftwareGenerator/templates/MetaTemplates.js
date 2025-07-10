/*globals define*/
/*
 * Финальная версия генератора YAML для Home Assistant.
 * Использует обогащенную процессором модель для корректной обработки всех типов переходов.
 */
define([
    'bower/js-yaml/dist/js-yaml.min', 
], function (
    jsyaml
) {
    'use strict';

    // --- Вспомогательные функции (без изменений) ---
    const toSnakeCase = (str) => {
        if (!str) return '';
        return str.replace(/[\s\W]+/g, '_')
                  .replace(/([A-Z])/g, '_$1')
                  .replace(/__+/g, '_')
                  .replace(/^_|_$/g, '')
                  .toLowerCase();
    };
    
    // ВАЖНО: Эта функция ожидает, что в полях Action/Entry/Exit будет ВАЛИДНЫЙ YAML.
    // 'qwerty' - это невалидный YAML. Пример валидного YAML:
    // service: notify.persistent_notification
    // data:
    //   message: "My action was executed!"
    const safeLoadYamlAction = (yamlString, logger) => {
        if (!yamlString || typeof yamlString !== 'string' || yamlString.trim() === '') return [];
        try {
            const parsed = jsyaml.load(yamlString);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object' && parsed !== null) return [parsed];
            (logger || console).warn(`Содержимое YAML было разобрано, но не является объектом/массивом: ${yamlString}`);
            return [];
        } catch (e) {
            (logger || console).warn(`Не удалось разобрать строку YAML. Ошибка: ${e.message}. Содержимое: "${yamlString}"`);
            return [];
        }
    };

    const getCircularReplacer = () => {
        const seen = new WeakSet();
        return (key, value) => {
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) {
                    return;
                }
                seen.add(value);
            }
            return value;
        };
    };
    
    const generateUniqueStateId = (stateNode) => {
        const namePart = toSnakeCase(stateNode.sanitizedName);
        const pathPart = stateNode.path.replace(/\//g, '_');
        return `${namePart}${pathPart}`;
    };
    
    // Эта функция больше не нужна в таком виде, так как логика встроена в основной цикл.
    // Оставляем ее на случай будущего рефакторинга.
    function buildActionSequence(transition, objects, smSnakeName, logger, stateIdMap) {
        let sequence = [];
        const targetNode = objects[transition.dstPath]; // Предполагаем, что dstPath есть
        sequence.push(...safeLoadYamlAction(transition.attributes.Action, logger));
        if (targetNode) {
             if (targetNode.type === 'State' || targetNode.type === 'End State') {
                sequence.push({
                    service: 'input_select.select_option',
                    target: { entity_id: `input_select.${smSnakeName}` },
                    data: { option: stateIdMap.get(targetNode) }
                });
                sequence.push(...safeLoadYamlAction(targetNode.attributes.Entry, logger));
            }
            // Логика для Choice Pseudostate должна быть здесь, если она понадобится
        }
        return sequence;
    }


    return {
        renderHFSM: function (model, namespace, objToFilePrefixFn) {
            const logger = this.logger || console;
            let generatedArtifacts = {};
            
            // --- НОВЫЙ ПОДХОД: РАЗБОР ДЕРЕВА МОДЕЛИ ---
            // Собираем все узлы в плоский словарь для удобного доступа
            const allObjects = {};
            function flattenTree(node) {
                if (!node || !node.path) return;
                allObjects[node.path] = node;
                if (node.childPaths) {
                    node.childPaths.forEach(childPath => {
                        // Рекурсивно обходим дочерние узлы, которые находятся внутри родителя
                        const childNode = Object.values(node).find(prop => prop && prop.path === childPath);
                        if (childNode) {
                           flattenTree(childNode);
                        }
                    });
                }
                 // Также обходим списки, которые создает процессор
                Object.keys(node).forEach(key => {
                    if (key.endsWith('_list') && Array.isArray(node[key])) {
                        node[key].forEach(item => flattenTree(item));
                    }
                });
            }
            flattenTree(model.root);
            // --- КОНЕЦ НОВОГО ПОДХОДА ---

            const smRoot = model.root;
            if (!smRoot || smRoot.type !== 'State Machine') {
                logger.warn('Корень модели не является "State Machine".');
                return {};
            }

            const smSnakeName = toSnakeCase(smRoot.sanitizedName);
            const inputSelectEntityId = `input_select.${smSnakeName}`;
            const eventType = `${smSnakeName}_event`;

            const states = Object.values(allObjects).filter(o => o.type === 'State' || o.type === 'End State');
            
            const stateIdMap = new Map();
            states.forEach(state => {
                stateIdMap.set(state, generateUniqueStateId(state));
            });
            
            let initialUniqueStateId = null;
            // Ищем начальный переход, который теперь точно есть в allObjects
            const initialTransition = Object.values(allObjects).find(t => t.src && t.src.type === 'Initial');
            if (initialTransition && initialTransition.dst) {
                initialUniqueStateId = stateIdMap.get(initialTransition.dst);
            }
            
            let haConfig = {};
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = { 
                name: smRoot.sanitizedName, 
                options: states.map(s => stateIdMap.get(s)), 
                initial: initialUniqueStateId, 
                icon: 'mdi:state-machine' 
            };
            
            const mainChoose = [];
            // Теперь итерируемся по всем найденным состояниям
            for (const state of states) {
                // Используем обогащенные процессором списки переходов
                const externalEvents = state.ExternalEvents || [];
                const internalEvents = state.InternalEvents || [];

                const allEvents = [...externalEvents, ...internalEvents];

                for (const event of allEvents) {
                    if (!event.name || !event.Transitions) continue;

                    for (const trans of event.Transitions) {
                        if (!trans) continue;

                        let sequence = [];

                        if (trans.isExternalTransition) {
                             sequence.push(...safeLoadYamlAction(state.attributes.Exit, logger));
                             sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));

                            // Обработка цели перехода (включая Choice)
                            let currentTarget = trans.dst;
                            if (currentTarget.isChoice) {
                                const choiceNode = currentTarget;
                                const guardedBranches = choiceNode.ExternalTransitions.filter(t => t.attributes.Guard);
                                const defaultBranch = choiceNode.ExternalTransitions.find(t => !t.attributes.Guard);
                                
                                const innerChoose = {
                                    choose: guardedBranches.map(branch => {
                                        const finalTarget = branch.dst;
                                        let branchSequence = safeLoadYamlAction(branch.attributes.Action, logger);
                                        branchSequence.push({ service: 'input_select.select_option', target: { entity_id: inputSelectEntityId }, data: { option: stateIdMap.get(finalTarget) } });
                                        branchSequence.push(...safeLoadYamlAction(finalTarget.attributes.Entry, logger));
                                        return {
                                            conditions: [{ condition: 'template', value_template: `{{ ${branch.attributes.Guard.replace(/^\[|\]$/g, '').trim()} }}` }],
                                            sequence: branchSequence
                                        };
                                    })
                                };

                                if (defaultBranch) {
                                    const finalTarget = defaultBranch.dst;
                                    let defaultSequence = safeLoadYamlAction(defaultBranch.attributes.Action, logger);
                                    defaultSequence.push({ service: 'input_select.select_option', target: { entity_id: inputSelectEntityId }, data: { option: stateIdMap.get(finalTarget) } });
                                    defaultSequence.push(...safeLoadYamlAction(finalTarget.attributes.Entry, logger));
                                    innerChoose.default = defaultSequence;
                                }
                                sequence.push(innerChoose);

                            } else {
                                // Простой переход
                                sequence.push({ service: 'input_select.select_option', target: { entity_id: inputSelectEntityId }, data: { option: stateIdMap.get(currentTarget) } });
                                sequence.push(...safeLoadYamlAction(currentTarget.attributes.Entry, logger));
                            }

                        } else { // Внутренний переход
                            sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));
                        }

                        if(sequence.length > 0) {
                            mainChoose.push({
                                conditions: [
                                    { condition: 'state', entity_id: inputSelectEntityId, state: stateIdMap.get(state) },
                                    { condition: 'template', value_template: `{{ trigger.event.data.event == '${event.name}' }}` }
                                ],
                                sequence: sequence
                            });
                        }
                    }
                }
            }
            
            haConfig.automation = [{ id: `${smSnakeName}_automation`, alias: `State Machine: ${smRoot.sanitizedName}`, description: `Handles state transitions for ${smRoot.sanitizedName}`, mode: 'single', trigger: [{ platform: 'event', event_type: eventType }], action: [{ choose: mainChoose }] }];
            
            const yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });
            const fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n#\n\n`;
            const yamlFileName = `${smSnakeName}.yaml`;
            generatedArtifacts[yamlFileName] = fileHeader + yamlString;
            
            logger.info('Сохранение исходной модели в JSON для отладки...');
            const jsonModelString = JSON.stringify(model, getCircularReplacer(), 2);
            const jsonModelFileName = `${smSnakeName}_model.json`;
            generatedArtifacts[jsonModelFileName] = jsonModelString;

            return generatedArtifacts;
        },

        renderTestCode: function (model, namespace, objToFilePrefixFn) {
            return {};
        }
    };
});